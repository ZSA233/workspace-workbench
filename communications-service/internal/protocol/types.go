// Package protocol contains API-v1 DTOs. Open records retain unknown stored fields
// across read/modify/write, so adding a provider does not discard historical data.
package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/zsa233/workspace-workbench/communications-service/internal/compat"
)

type Record map[string]any
type Message = Record
type Group = Record
type Candidate = Record
type Requirement = Record
type Task = Record
type Delivery = Record

func Decode(b []byte) (Record, error) {
	var r Record
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	err := d.Decode(&r)
	if err == nil {
		var extra any
		if d.Decode(&extra) != io.EOF {
			err = errors.New("invalid_json")
		}
	}
	if err == nil && r == nil {
		err = errors.New("invalid_request")
	}
	return r, err
}
func (r Record) S(k string) string { v, _ := r[k].(string); return v }
func (r Record) N(k string) int64 {
	switch v := r[k].(type) {
	case json.Number:
		n, e := v.Int64()
		if e != nil {
			f, _ := v.Float64()
			return int64(f)
		}
		return n
	case int:
		return int64(v)
	case int64:
		return v
	case float64:
		return int64(v)
	}
	return 0
}
func (r Record) B(k string) bool { v, _ := r[k].(bool); return v }
func (r Record) O(k string) Record {
	switch v := r[k].(type) {
	case Record:
		return v
	case map[string]any:
		return Record(v)
	}
	return Record{}
}
func (r Record) A(k string) []any {
	v, _ := r[k].([]any)
	if v == nil {
		return []any{}
	}
	return v
}
func (r Record) Strings(k string) []string {
	out := []string{}
	switch a := r[k].(type) {
	case []string:
		return a
	case []any:
		for _, v := range a {
			if s, ok := v.(string); ok {
				out = append(out, s)
			}
		}
	}
	return out
}
func (r Record) Records(k string) []Record {
	out := []Record{}
	switch a := r[k].(type) {
	case []Record:
		return a
	case []any:
		for _, v := range a {
			switch o := v.(type) {
			case Record:
				out = append(out, o)
			case map[string]any:
				out = append(out, Record(o))
			}
		}
	}
	return out
}
func (r Record) Clone() Record {
	if r == nil {
		return Record{}
	}
	v, _ := Decode(compat.JSON(r))
	return v
}
func (r Record) With(patch Record) Record {
	v := r.Clone()
	for k, item := range patch {
		v[k] = item
	}
	return v
}
func Error(code string) error { return errors.New(code) }
func Length(s string) int     { return len(utf16.Encode([]rune(s))) }
func Pending() Record         { return Record{"state": "pending"} }
func EmptySource() Record {
	return Record{"installed": false, "authenticated": false, "state": "not-installed", "capabilities": Record{"messages": Pending(), "history": Pending(), "attachments": Pending()}}
}

var Categories = []string{"requirement", "change", "feedback", "bug", "decision"}

type SourceConfig struct {
	Executable string `json:"executable"`
	Mode       string `json:"mode"`
	ClientID   string `json:"clientId"`
	Profile    string `json:"profile"`
	BotID      string `json:"botId"`
}
type ModelConfig struct {
	Protocol      string `json:"protocol"`
	BaseURL       string `json:"baseUrl"`
	Model         string `json:"model"`
	TimeoutMS     int    `json:"timeoutMs"`
	ContextTokens int    `json:"contextTokens"`
	OutputTokens  int    `json:"outputTokens"`
	ModelLimit    int    `json:"modelLimit"`
	Vision        bool   `json:"vision"`
}
type AnalysisConfig struct {
	Enabled          bool     `json:"enabled"`
	CoalesceSeconds  int      `json:"coalesceSeconds"`
	ReconcileSeconds int      `json:"reconcileSeconds"`
	FocusPeople      []string `json:"focusPeople"`
	Keywords         []string `json:"keywords"`
	Categories       []string `json:"categories"`
	Instructions     string   `json:"instructions"`
}
type Config struct {
	Source   SourceConfig   `json:"source"`
	Model    ModelConfig    `json:"model"`
	Analysis AnalysisConfig `json:"analysis"`
}

func Defaults() Config {
	return Config{SourceConfig{"dws", "custom", "", "", ""}, ModelConfig{"chat-completions", "http://127.0.0.1:12345/v1", "", 180000, 131072, 8192, 524288, true}, AnalysisConfig{true, 30, 60, []string{}, []string{}, slices.Clone(Categories), "保留讨论上下文，识别明确的需求、变更、反馈、缺陷和决策；不确定内容标为待核实。"}}
}
func ParseConfig(input any) (Config, error) {
	input = NormalizeNumbers(input)
	c := Defaults()
	b := compat.JSON(input)
	obj, err := Decode(b)
	if err != nil {
		return c, Error("invalid_config")
	}
	obj = filterKnown(obj, c.Record())
	b = compat.JSON(obj)
	for _, k := range []string{"source", "model", "analysis"} {
		if v, ok := obj[k]; ok {
			if _, err := Decode(compat.JSON(v)); err != nil {
				return c, Error("invalid_config")
			}
		}
	}
	if err = json.Unmarshal(b, &c); err != nil {
		return c, Error("invalid_config")
	}
	// JSON null must not silently become a default scalar in Go.
	var check func(any) bool
	check = func(v any) bool {
		if v == nil {
			return false
		}
		switch x := v.(type) {
		case map[string]any:
			for _, i := range x {
				if !check(i) {
					return false
				}
			}
		case Record:
			for _, i := range x {
				if !check(i) {
					return false
				}
			}
		case []any:
			for _, i := range x {
				if !check(i) {
					return false
				}
			}
		}
		return true
	}
	if !check(obj) {
		return c, Error("invalid_config")
	}
	s, m, a := c.Source, c.Model, c.Analysis
	if Length(s.Executable) < 1 || Length(s.Executable) > 2048 || !slices.Contains([]string{"default", "custom"}, s.Mode) || Length(s.ClientID) > 512 || Length(s.Profile) > 512 || Length(s.BotID) > 512 {
		return c, Error("invalid_config")
	}
	if m.Protocol != "chat-completions" || Length(m.Model) > 512 || m.TimeoutMS < 1000 || m.TimeoutMS > 600000 || m.ContextTokens < 4096 || m.ContextTokens > 4194304 || m.OutputTokens < 256 || m.OutputTokens > 131072 || m.ModelLimit < 4096 || m.ModelLimit > 4194304 {
		return c, Error("invalid_config")
	}
	if m.ContextTokens > m.ModelLimit {
		return c, Error("上下文预算超过模型上限")
	}
	if m.OutputTokens >= m.ContextTokens {
		return c, Error("输出预留必须小于上下文预算")
	}
	u, err := url.Parse(m.BaseURL)
	if err != nil || u.Host == "" || !slices.Contains([]string{"http", "https"}, u.Scheme) || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return c, Error("模型地址必须是无凭证、无查询参数的 HTTP(S) 地址")
	}
	if a.CoalesceSeconds < 1 || a.CoalesceSeconds > 3600 || a.ReconcileSeconds < 15 || a.ReconcileSeconds > 3600 || len(a.FocusPeople) > 100 || len(a.Keywords) > 100 || len(a.Categories) < 1 || Length(a.Instructions) > 16000 {
		return c, Error("invalid_config")
	}
	for _, v := range append(slices.Clone(a.FocusPeople), a.Keywords...) {
		if Length(v) > 200 {
			return c, Error("invalid_config")
		}
	}
	for _, v := range a.Categories {
		if !slices.Contains(Categories, v) {
			return c, Error("invalid_config")
		}
	}
	return c, nil
}
func (c Config) Record() Record { r, _ := Decode(compat.JSON(c)); return r }

type Action struct {
	Kind   string
	Values Record
}

func ParseAction(input Record) (Action, error) {
	input = NormalizeNumbers(input).(Record)
	kind := input.S("action")
	out := Record{"action": kind}
	errInvalid := fmt.Errorf("invalid_request: %s", kind)
	str := func(k string, min, max int, optional bool) bool {
		v, ok := input[k]
		if !ok {
			return optional
		}
		s, ok := v.(string)
		if !ok || Length(s) < min || Length(s) > max {
			return false
		}
		out[k] = s
		return true
	}
	integer := func(k string, min, max int64, optional bool, def *int64) bool {
		v, ok := input[k]
		if !ok {
			if def != nil {
				out[k] = *def
				return true
			}
			return optional
		}
		r := Record{"v": v}
		b := compat.JSON(v)
		var n int64
		if json.Unmarshal(b, &n) != nil || n < min || n > max {
			return false
		}
		out[k] = r.N("v")
		return true
	}
	number := func(k string) bool {
		v, ok := input[k]
		if !ok {
			return true
		}
		var n float64
		if json.Unmarshal(compat.JSON(v), &n) != nil || math.IsInf(n, 0) || math.IsNaN(n) {
			return false
		}
		out[k] = v
		return true
	}
	boolean := func(k string, def bool) bool {
		v, ok := input[k]
		if !ok {
			out[k] = def
			return true
		}
		b, ok := v.(bool)
		if ok {
			out[k] = b
		}
		return ok
	}
	array := func(k string, max int) bool {
		v, ok := input[k].([]any)
		if !ok {
			if a, yes := input[k].([]string); yes {
				v = make([]any, len(a))
				for i, s := range a {
					v[i] = s
				}
				ok = true
			}
		}
		if !ok || len(v) > max {
			return false
		}
		for _, s := range v {
			text, yes := s.(string)
			if !yes || Length(text) < 1 || Length(text) > 512 {
				return false
			}
		}
		out[k] = v
		return true
	}
	target := func(k string) bool { return str(k, 1, 512, false) }
	limit := int64(50)
	allInt := int64(9007199254740991)
	valid := true
	switch kind {
	case "snapshot", "connection.check", "auth.start", "models.check", "generation.check", "analysis.retry", "delivery.targets":
	case "configure":
		valid = integer("revision", -allInt, allInt, false, nil)
		c, e := ParseConfig(input["config"])
		if e != nil {
			return Action{}, e
		}
		out["config"] = c.Record()
		valid = valid && str("modelKey", 0, 16384, true) && str("appSecret", 0, 16384, true)
	case "groups.search":
		valid = str("query", 1, 200, false)
	case "groups.bind":
		valid = target("groupId") && str("name", 1, 512, false)
	case "groups.pause", "groups.resume", "groups.remove", "sync.start":
		valid = target("groupId")
	case "messages.list":
		valid = str("groupId", 1, 512, true) && str("query", 0, 500, true) && number("before") && str("beforeId", 1, 512, true) && integer("limit", 1, 100, false, &limit)
		if _, ok := out["query"]; !ok {
			out["query"] = ""
		}
	case "messages.read":
		valid = array("ids", 100)
	case "attachment.read", "candidate.read", "candidate.ignore", "candidate.snooze", "requirement.history", "delivery.send", "delivery.status":
		valid = target("id")
	case "candidate.list":
		valid = str("query", 0, 500, true) && boolean("includeSnoozed", false) && integer("limit", 1, 100, false, &limit)
		if _, ok := out["query"]; !ok {
			out["query"] = ""
		}
		if v, ok := input["before"]; ok {
			b, e := Decode(compat.JSON(v))
			if e != nil || b.S("id") == "" || Length(b.S("id")) > 512 || b["time"] == nil {
				return Action{}, errInvalid
			}
			var n float64
			if json.Unmarshal(compat.JSON(b["time"]), &n) != nil {
				return Action{}, errInvalid
			}
			out["before"] = b
		}
	case "requirement.list":
		valid = str("query", 0, 500, true) && integer("before", 1, allInt, true, nil) && integer("limit", 1, 100, false, &limit)
		if _, ok := out["query"]; !ok {
			out["query"] = ""
		}
	case "candidate.preview", "candidate.accept":
		valid = target("id") && integer("revision", -allInt, allInt, false, nil) && str("title", 1, 500, false) && str("body", 1, 32000, false) && str("relatedRequirementId", 1, 512, true) && integer("expectedVersion", 0, allInt, true, nil)
	case "delivery.preview":
		valid = target("requirementId") && integer("version", -allInt, allInt, false, nil) && target("workspaceId") && array("messageIds", 100) && array("attachmentIds", 20)
	default:
		valid = false
	}
	if !valid {
		return Action{}, errInvalid
	}
	return Action{kind, out}, nil
}
func Unique(values []string) []string {
	out := []string{}
	for _, v := range values {
		if !slices.Contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}
func Clean(s string) string { return strings.TrimSpace(s) }

func NormalizeNumbers(v any) any {
	switch x := v.(type) {
	case json.Number:
		f, e := x.Float64()
		if e == nil && math.Trunc(f) == f && math.Abs(f) <= 9007199254740991 {
			return int64(f)
		}
	case Record:
		r := Record{}
		for k, v := range x {
			r[k] = NormalizeNumbers(v)
		}
		return r
	case map[string]any:
		r := Record{}
		for k, v := range x {
			r[k] = NormalizeNumbers(v)
		}
		return r
	case []any:
		r := make([]any, len(x))
		for i, v := range x {
			r[i] = NormalizeNumbers(v)
		}
		return r
	}
	return v
}

func filterKnown(input, defaults Record) Record {
	out := Record{}
	for k, d := range defaults {
		v, ok := input[k]
		if !ok {
			continue
		}
		if nested, ok := d.(map[string]any); ok {
			if o, ok := v.(Record); ok {
				v = filterKnown(o, Record(nested))
			} else if o, ok := v.(map[string]any); ok {
				v = filterKnown(Record(o), Record(nested))
			}
		}
		out[k] = v
	}
	return out
}

func (r Record) Float(k string) float64 {
	v := r[k]
	if n, ok := v.(json.Number); ok {
		f, _ := n.Float64()
		return f
	}
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case int64:
		return float64(n)
	}
	return 0
}
