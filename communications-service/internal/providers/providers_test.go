package providers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/zsa233/workspace-workbench/communications-service/internal/compat"
	p "github.com/zsa233/workspace-workbench/communications-service/internal/protocol"
)

func TestMain(m *testing.M) {
	if os.Getenv("DWS_GO_TEST_HELPER") == "1" {
		helperDWS()
		return
	}
	os.Exit(m.Run())
}
func helperDWS() {
	args := os.Args[1:]
	emit := func(v any) { _ = json.NewEncoder(os.Stdout).Encode(v) }
	has := func(v string) bool { return slices.Contains(args, v) }
	if len(args) > 0 && args[0] == "hold" {
		signal.Ignore(syscall.SIGTERM)
		time.Sleep(time.Hour)
		return
	}
	if len(args) > 0 && args[0] == "version" {
		fmt.Println("dws v1.0.68")
		return
	}
	if len(args) > 0 && args[0] == "auth" {
		emit(p.Record{"success": true, "authenticated": true, "corp_id": "corp", "user_id": "user"})
		return
	}
	if has("+chat-bots") {
		emit(p.Record{"bots": []p.Record{{"openBotId": "bot"}}, "complete": true, "hasMore": false})
		return
	}
	if has("+chat-search") {
		emit(p.Record{"groups": []p.Record{{"openConversationId": "g", "name": "项目群"}}, "complete": true, "hasMore": false})
		return
	}
	if has("+chat-messages") {
		emit(p.Record{"messages": []p.Record{{"messageId": "ordinary", "conversationId": "g", "createTime": 1700000000000, "text": "没有艾特的需求"}}, "complete": true, "hasMore": false})
		return
	}
	if has("+messages-resource-download") {
		_ = os.WriteFile("payload.bin", []byte("附件原件"), 0600)
		emit(p.Record{"resourceId": "@resource", "messageId": "ordinary", "localPath": "payload.bin"})
		return
	}
	if has("+listen-im") {
		if path := os.Getenv("DWS_CHILD_PID_FILE"); path != "" {
			child := exec.Command(os.Args[0], "hold")
			child.Env = os.Environ()
			child.Stdout = os.Stdout
			child.Stderr = os.Stderr
			if child.Start() == nil {
				_ = os.WriteFile(path, []byte(fmt.Sprint(child.Process.Pid)), 0600)
			}
		}
		fmt.Fprintln(os.Stderr, "[event] ready")
		time.Sleep(20 * time.Millisecond)
		emit(p.Record{"message_id": "live", "conversation_id": "g", "create_time": "1700000001000", "content": "普通实时消息"})
		signal.Ignore(syscall.SIGTERM)
		time.Sleep(time.Hour)
		return
	}
	os.Exit(2)
}
func TestNodeMessageNormalization(t *testing.T) {
	b, e := os.ReadFile("../../testdata/node-v1/golden.json")
	if e != nil {
		t.Fatal(e)
	}
	r, e := p.Decode(b)
	if e != nil {
		t.Fatal(e)
	}
	for _, v := range r.Records("normalizations") {
		m, e := NormalizeMessage(v.O("raw"), "group-one", "corp:user")
		if e != nil {
			t.Fatal(e)
		}
		got, _ := p.Decode(compat.JSON(m))
		if !reflect.DeepEqual(got, v.O("normalized")) {
			t.Fatalf("%s got %s want %s", v.S("name"), compat.JSON(got), compat.JSON(v["normalized"]))
		}
	}
	for _, v := range r.Records("hashes") {
		if compat.HashBytes([]byte(v.S("serialized"))) != v.S("hash") {
			t.Fatal("hash mismatch")
		}
	}
	for _, raw := range []p.Record{{"messageId": "id", "createTime": "bad"}, {"messageId": "id", "createTime": 1700000000000, "conversationId": "other"}, {"createTime": 1700000000000}} {
		if _, e := NormalizeMessage(raw, "g", "corp:user"); e == nil {
			t.Fatal(raw)
		}
	}
	partial, e := DecodePage(p.Record{"messages": []any{}, "complete": true, "hasMore": false, "failures": []any{p.Record{}}}, "g", "p")
	if e != nil || partial.Complete {
		t.Fatal(partial, e)
	}
}
func TestOwnedDWSProcessesCancelAndReadOrdinaryMessages(t *testing.T) {
	t.Setenv("DWS_GO_TEST_HELPER", "1")
	root := t.TempDir()
	pidFile := filepath.Join(root, "child.pid")
	t.Setenv("DWS_CHILD_PID_FILE", pidFile)
	c := p.Defaults()
	exe, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	c.Source = p.SourceConfig{Executable: exe, Mode: "custom", ClientID: "fixture", BotID: "bot"}
	d := NewDWS(root, func() p.Config { return c }, func() (string, error) { return "test-secret", nil }, NewLimits())
	defer d.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	status, e := d.Check(ctx)
	if e != nil || !status.B("authenticated") {
		t.Fatal(status, e)
	}
	g := p.Group{"id": "g"}
	member, e := d.VerifyMembership(ctx, g)
	if e != nil || !member {
		t.Fatal(member, e)
	}
	groups, e := d.SearchGroups(ctx, "项目")
	if e != nil || len(groups) != 1 {
		t.Fatal(groups, e)
	}
	page, e := d.Read(ctx, g, 1700000000000, 1700000002000, "")
	if e != nil || len(page.Messages) != 1 || len(page.Messages[0].Strings("mentions")) > 0 {
		t.Fatal(page, e)
	}
	received := make(chan p.Record, 1)
	ready := make(chan struct{})
	errs := make(chan error, 1)
	stop, e := d.Subscribe(ctx, g, func(m p.Message) { received <- m }, func() { close(ready) }, func(e error) { errs <- e })
	if e != nil {
		t.Fatal(e)
	}
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case m := <-received:
		if m.S("sourceId") != "live" {
			t.Fatal(m)
		}
	case e := <-errs:
		t.Fatal(e)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	start := time.Now()
	stop()
	if time.Since(start) > 6*time.Second {
		t.Fatal("unbounded stop")
	}
	var pid int
	b, _ := os.ReadFile(pidFile)
	fmt.Sscan(string(b), &pid)
	if pid <= 0 {
		t.Fatal("missing owned child")
	}
	for range 100 {
		if e = syscall.Kill(pid, 0); errors.Is(e, syscall.ESRCH) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !errors.Is(e, syscall.ESRCH) {
		t.Fatalf("descendant survived process group cancellation: %d", pid)
	}
	data, mime, e := d.Download(ctx, p.Message{"sourceId": "ordinary", "groupId": "g"}, p.Record{"resourceType": "mediaId", "sourceId": "@resource", "mimeType": "text/plain", "name": "需求.txt"})
	if e != nil || string(data) != "附件原件" || mime != "text/plain" {
		t.Fatal(string(data), mime, e)
	}
}
func TestModelsBudgetEvidenceAndTimeout(t *testing.T) {
	c := p.Defaults()
	c.Model.Model = "fixture"
	c.Model.ContextTokens = 8192
	c.Model.OutputTokens = 1024
	c.Model.TimeoutMS = 1000
	var mu sync.Mutex
	seen := []string{}
	mode := "valid"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/models" {
			json.NewEncoder(w).Encode(p.Record{"data": []p.Record{{"id": "fixture", "context_length": 524288}}})
			return
		}
		raw := p.Record{}
		json.NewDecoder(r.Body).Decode(&raw)
		messages := raw.Records("messages")
		if len(messages) == 1 {
			json.NewEncoder(w).Encode(p.Record{"choices": []p.Record{{"message": p.Record{"content": "OK"}}}})
			return
		}
		mu.Lock()
		current := mode
		mu.Unlock()
		if current == "timeout" {
			<-r.Context().Done()
			return
		}
		if current == "bad" {
			fmt.Fprint(w, "invalid JSON")
			return
		}
		contextData, e := p.Decode([]byte(messages[1].S("content")))
		if e != nil {
			t.Error(e)
			return
		}
		evidence := []string{}
		for _, m := range contextData.Records("messages") {
			mu.Lock()
			seen = append(seen, m.S("text"))
			mu.Unlock()
			evidence = append(evidence, m.S("id"))
		}
		if current == "invented" {
			evidence = []string{"invented"}
		}
		if raw.N("max_tokens") != 1024 {
			t.Error("output budget")
		}
		content := p.Record{"summary": "摘要", "candidates": []p.Record{{"title": "需求", "body": "内容", "category": "requirement", "evidenceIds": evidence, "uncertainty": ""}}}
		json.NewEncoder(w).Encode(p.Record{"choices": []p.Record{{"message": p.Record{"content": string(compat.JSON(content))}}}})
	}))
	defer server.Close()
	c.Model.BaseURL = server.URL
	m := NewModel(func() p.Config { return c }, func() (string, error) { return "", nil }, NewLimits())
	models, e := m.Models(context.Background())
	if e != nil || models[0].N("contextTokens") != 524288 {
		t.Fatal(models, e)
	}
	if e = m.Check(context.Background()); e != nil {
		t.Fatal(e)
	}
	original := strings.Repeat("详细讨论😀", 1500)
	input := AnalysisInput{Config: c, Messages: []p.Message{{"id": "m", "text": original, "attachments": []p.Record{}}}}
	out, e := m.Analyze(context.Background(), input)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Join(seen, "") != original || len(seen) < 2 || out.EstimatedTokens <= 0 {
		t.Fatal("truncated discussion")
	}
	for _, value := range []string{"invented", "bad", "timeout"} {
		mu.Lock()
		mode = value
		mu.Unlock()
		if _, e = m.Analyze(context.Background(), input); e == nil {
			t.Fatal(value)
		}
	}
	if _, e = ModelBatches(input.Messages, 10); e == nil {
		t.Fatal("budget not checked")
	}
}

func TestObjectMessageTextRetainsSourcePropertyOrder(t *testing.T) {
	r, e := decodeDWSJSON([]byte(`{"messageId":"object","createTime":1700000000000,"content":{"z":"最后<>&","a":"先前","nested":{"b":2,"a":1}}}`))
	if e != nil {
		t.Fatal(e)
	}
	m, e := NormalizeMessage(r, "g", "p")
	if e != nil {
		t.Fatal(e)
	}
	if m.S("text") != `{"z":"最后<>&","a":"先前","nested":{"b":2,"a":1}}` {
		t.Fatal(m.S("text"))
	}
}

func TestGenerationLimitIsSharedAcrossProjectsAndWaitingCanCancel(t *testing.T) {
	limits := NewLimits()
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		json.NewEncoder(w).Encode(p.Record{"choices": []p.Record{{"message": p.Record{"content": "OK"}}}})
	}))
	defer server.Close()
	cfg := p.Defaults()
	cfg.Model.BaseURL = server.URL
	cfg.Model.Model = "fixture"
	one := NewModel(func() p.Config { return cfg }, func() (string, error) { return "", nil }, limits)
	two := NewModel(func() p.Config { return cfg }, func() (string, error) { return "", nil }, limits)
	done := make(chan error, 1)
	go func() { done <- one.Check(context.Background()) }()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	waiting := make(chan error, 1)
	go func() { waiting <- two.Check(ctx) }()
	time.Sleep(20 * time.Millisecond)
	select {
	case <-started:
		t.Fatal("second project bypassed limit")
	default:
	}
	cancel()
	if e := <-waiting; e == nil {
		t.Fatal("waiting generation ignored cancellation")
	}
	close(release)
	if e := <-done; e != nil {
		t.Fatal(e)
	}
	if cap(limits.DWS) != 4 {
		t.Fatal("DWS limit")
	}
}

func TestSourceObjectNumbersMatchJavaScriptStringify(t *testing.T) {
	raw, e := decodeDWSJSON([]byte(`{"messageId":"m","createTime":1700000000000,"content":{"a":1.00,"b":1e3,"negativeZero":-0,"tiny":1e-7}}`))
	if e != nil {
		t.Fatal(e)
	}
	m, e := NormalizeMessage(raw, "g", "p")
	if e != nil {
		t.Fatal(e)
	}
	if m.S("text") != `{"a":1,"b":1000,"negativeZero":0,"tiny":1e-7}` {
		t.Fatal(m.S("text"))
	}
}

func TestMalformedPageCannotAdvanceACompleteCheckpoint(t *testing.T) {
	raw, e := decodeDWSJSON([]byte(`{"messages":[null,42,"not a message"],"complete":true,"hasMore":false}`))
	if e != nil {
		t.Fatal(e)
	}
	if page, e := DecodePage(raw, "g", "p"); e == nil || page.Complete {
		t.Fatal("malformed records were dropped and checkpoint would advance", page, e)
	}
}
