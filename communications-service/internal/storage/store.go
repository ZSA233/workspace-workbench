package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/zsa233/workspace-workbench/communications-service/internal/compat"
	p "github.com/zsa233/workspace-workbench/communications-service/internal/protocol"
	_ "modernc.org/sqlite"
)

const schema = `PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS groups(id TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,group_id TEXT NOT NULL,created INTEGER NOT NULL,version TEXT NOT NULL,analyzed TEXT,json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS messages_group ON messages(group_id,created,id);
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(id UNINDEXED,text,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requirements(id TEXT PRIMARY KEY,number INTEGER UNIQUE NOT NULL,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS requirement_versions(id TEXT NOT NULL,version INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(id,version));
CREATE VIRTUAL TABLE IF NOT EXISTS requirement_fts USING fts5(id UNINDEXED,text,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,updated INTEGER NOT NULL,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,json TEXT NOT NULL);`

type Store struct {
	Root   string
	db     *sql.DB
	mu     sync.Mutex
	closed bool
}
type Tx struct {
	tx   *sql.Tx
	ctx  context.Context
	root string
	err  error
}

func Open(root string) (*Store, error) {
	if e := Directory(root); e != nil {
		return nil, e
	}
	file := filepath.Join(root, "communications.sqlite")
	if _, e := os.Lstat(file); e == nil {
		if e = Regular(file); e != nil {
			return nil, e
		}
	}
	db, e := sql.Open("sqlite", file)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	if _, e = db.Exec(schema); e != nil {
		db.Close()
		return nil, e
	}
	if e = os.Chmod(file, 0600); e != nil {
		db.Close()
		return nil, e
	}
	s := &Store{Root: root, db: db}
	_, e = s.Do(context.Background(), func(t *Tx) (any, error) {
		if t.Meta("settings") == nil {
			t.SetMeta("settings", p.Record{"revision": 1, "config": p.Defaults()})
		}
		for _, task := range t.All("SELECT json FROM tasks WHERE json_extract(json,'$.state') IN ('running','waiting','queued')") {
			t.SaveTask(task.With(p.Record{"state": "cancelled", "detail": "服务重启，任务已中断；同步与分析将从已保存断点恢复", "updatedAt": time.Now().UnixMilli()}))
		}
		for _, d := range t.All("SELECT json FROM deliveries WHERE json_extract(json,'$.state')='sending'") {
			t.Save("deliveries", d.With(p.Record{"state": "uncertain"}))
		}
		return nil, nil
	})
	if e != nil {
		db.Close()
		return nil, e
	}
	return s, nil
}
func (s *Store) Do(ctx context.Context, fn func(*Tx) (any, error)) (any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errors.New("extension_stopped")
	}
	tx, e := s.db.BeginTx(ctx, nil)
	if e != nil {
		return nil, e
	}
	t := &Tx{tx: tx, ctx: ctx, root: s.Root}
	v, e := fn(t)
	if e == nil {
		e = t.err
	}
	if e != nil {
		tx.Rollback()
		return nil, e
	}
	if e = tx.Commit(); e != nil {
		return nil, e
	}
	return v, nil
}
func (s *Store) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	return s.db.Close()
}
func (t *Tx) Exec(query string, args ...any) {
	if t.err != nil {
		return
	}
	_, t.err = t.tx.ExecContext(t.ctx, query, args...)
}
func (t *Tx) All(query string, args ...any) []p.Record {
	out := []p.Record{}
	if t.err != nil {
		return out
	}
	rows, e := t.tx.QueryContext(t.ctx, query, args...)
	if e != nil {
		t.err = e
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var raw []byte
		if e = rows.Scan(&raw); e != nil {
			t.err = e
			return out
		}
		v, e := p.Decode(raw)
		if e != nil {
			t.err = e
			return out
		}
		out = append(out, v)
	}
	t.err = rows.Err()
	return out
}
func (t *Tx) One(query string, args ...any) p.Record {
	a := t.All(query, args...)
	if len(a) == 0 {
		return nil
	}
	return a[0]
}
func (t *Tx) Count(query string, args ...any) int64 {
	if t.err != nil {
		return 0
	}
	var n int64
	t.err = t.tx.QueryRowContext(t.ctx, query, args...).Scan(&n)
	return n
}
func (t *Tx) Meta(key string) p.Record { return t.One("SELECT json FROM meta WHERE key=?", key) }
func (t *Tx) MetaText(key string) string {
	if t.err != nil {
		return ""
	}
	var b string
	e := t.tx.QueryRowContext(t.ctx, "SELECT json FROM meta WHERE key=?", key).Scan(&b)
	if e == sql.ErrNoRows {
		return ""
	}
	if e != nil {
		t.err = e
		return ""
	}
	var s string
	if e = jsonText(b, &s); e != nil {
		t.err = e
	}
	return s
}
func jsonText(b string, out *string) error {
	r, e := p.Decode([]byte(`{"value":` + b + `}`))
	if e == nil {
		*out = r.S("value")
	}
	return e
}
func (t *Tx) SetMeta(key string, value any) {
	t.Exec("INSERT OR REPLACE INTO meta VALUES(?,?)", key, string(compat.JSON(value)))
}
func (t *Tx) Get(table, id string) p.Record {
	return t.One("SELECT json FROM "+table+" WHERE id=?", id)
}
func (t *Tx) Save(table string, r p.Record) {
	t.Exec("INSERT INTO "+table+"(id,json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json", r.S("id"), string(compat.JSON(r)))
}
func (t *Tx) SaveTask(r p.Record) {
	t.Exec("INSERT OR REPLACE INTO tasks VALUES(?,?,?)", r.S("id"), r.N("updatedAt"), string(compat.JSON(r)))
	t.Exec("DELETE FROM tasks WHERE id IN (SELECT id FROM tasks WHERE json_extract(json,'$.state') IN ('complete','failed','cancelled') ORDER BY updated DESC LIMIT -1 OFFSET 500)")
}
func (t *Tx) Settings() (int64, p.Config, error) {
	r := t.Meta("settings")
	if r == nil {
		return 0, p.Config{}, errors.New("settings_missing")
	}
	c, e := p.ParseConfig(r["config"])
	return r.N("revision"), c, e
}
func (t *Tx) Configure(revision int64, c p.Config) (p.Record, error) {
	r := t.Meta("settings")
	if r.N("revision") != revision {
		return nil, errors.New("settings_revision_conflict")
	}
	next := r.With(p.Record{"revision": revision + 1, "config": c})
	t.SetMeta("settings", next)
	return next, nil
}
func (t *Tx) Groups() []p.Record { return t.All("SELECT json FROM groups ORDER BY id") }
func (t *Tx) Snapshot() p.Record {
	r := t.Meta("settings")
	counts := t.One("SELECT json_object('unread',coalesce(sum(CASE WHEN json_extract(json,'$.unread')=1 THEN 1 ELSE 0 END),0),'pending',coalesce(sum(CASE WHEN json_extract(json,'$.status')='pending' THEN 1 ELSE 0 END),0)) FROM candidates")
	return r.With(p.Record{"groups": t.Groups(), "candidates": t.All("SELECT json FROM candidates ORDER BY rowid DESC LIMIT 500"), "requirements": t.All("SELECT json FROM requirements ORDER BY number DESC LIMIT 500"), "requirementCount": t.Count("SELECT count(*) FROM requirements"), "tasks": t.All("SELECT json FROM tasks ORDER BY updated DESC LIMIT 50"), "unread": counts.N("unread"), "pending": counts.N("pending"), "messageCount": t.Count("SELECT count(*) FROM messages"), "analysisPending": t.Count("SELECT count(*) FROM messages WHERE analyzed IS NULL OR analyzed<>version")})
}
func (t *Tx) Ingest(messages []p.Message, groupID string, generation int64) int {
	g := t.Get("groups", groupID)
	if g == nil || !g.B("enabled") || g.N("generation") != generation || g.O("membership").S("state") != "verified" {
		return 0
	}
	changed := 0
	for _, message := range messages {
		if message.S("groupId") != groupID || message.N("createdAt") < g.N("boundAt") {
			continue
		}
		old := t.Get("messages", message.S("id"))
		if old != nil && (old.S("version") == message.S("version") || old.N("updatedAt") > message.N("updatedAt")) {
			continue
		}
		m := message.Clone()
		if old != nil {
			m = old.With(m)
		}
		attachments := m.Records("attachments")
		for i, a := range attachments {
			for _, prev := range old.Records("attachments") {
				if a.S("id") == prev.S("id") && prev.S("state") == "ready" {
					attachments[i] = prev
				}
			}
		}
		m["attachments"] = attachments
		t.Exec("INSERT INTO messages(id,group_id,created,version,analyzed,json) VALUES(?,?,?,?,NULL,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,analyzed=NULL,json=excluded.json", m.S("id"), groupID, m.N("createdAt"), m.S("version"), string(compat.JSON(m)))
		// A new stable message ID has no old FTS row. Avoid an O(n) FTS scan
		// per insertion during backfill; edits still replace their previous index.
		if old != nil {
			t.Exec("DELETE FROM message_fts WHERE id=?", m.S("id"))
		}
		t.Exec("INSERT INTO message_fts VALUES(?,?)", m.S("id"), m.S("text"))
		changed++
	}
	return changed
}
func fts(query string) string {
	terms := strings.Fields(query)
	if len(terms) > 20 {
		terms = terms[:20]
	}
	for i, v := range terms {
		terms[i] = `"` + strings.ReplaceAll(v, `"`, `""`) + `"`
	}
	if len(terms) == 0 {
		return `""`
	}
	return strings.Join(terms, " OR ")
}
func like(s string) string {
	return "%" + strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s) + "%"
}
func (t *Tx) Messages(r p.Record, limit int64) []p.Record {
	var before any
	if _, ok := r["before"]; ok {
		before = r.Float("before")
	}
	q := strings.TrimSpace(r.S("query"))
	return t.All(`SELECT json FROM messages WHERE (?='' OR group_id=?) AND (? IS NULL OR created<? OR (created=? AND id<?)) AND (?='' OR id IN (SELECT id FROM message_fts WHERE message_fts MATCH ?) OR json_extract(json,'$.text') LIKE ? ESCAPE '\') ORDER BY created DESC,id DESC LIMIT ?`, r.S("groupId"), r.S("groupId"), before, before, before, r.S("beforeId"), q, fts(q), like(q), limit)
}
func Public(m p.Record) p.Record { r := m.Clone(); delete(r, "raw"); return r }
func (t *Tx) Pending(group string) []p.Record {
	return t.All("SELECT json FROM messages WHERE group_id=? AND (analyzed IS NULL OR analyzed<>version) ORDER BY created,id LIMIT 100", group)
}
func (t *Tx) Related(query string, limit int) []p.Record {
	if query == "" {
		return t.All("SELECT json FROM requirements ORDER BY number DESC LIMIT ?", limit)
	}
	found := t.All("SELECT r.json FROM requirements r JOIN requirement_fts f ON r.id=f.id WHERE requirement_fts MATCH ? ORDER BY rank LIMIT ?", fts(query), limit)
	return found
}
func (t *Tx) RecordAnalysis(job string, messages, proposals []p.Record, generation int64) bool {
	if len(messages) == 0 {
		return false
	}
	g := t.Get("groups", messages[0].S("groupId"))
	if g == nil || !g.B("enabled") || g.N("generation") != generation || g.O("membership").S("state") != "verified" {
		return false
	}
	valid := []string{}
	for _, m := range messages {
		old := t.Get("messages", m.S("id"))
		if old.S("version") != m.S("version") {
			return false
		}
		valid = append(valid, m.S("id"))
	}
	if t.Count("SELECT count(*) FROM candidates WHERE job_id=?", job) == 0 {
		for _, proposal := range proposals {
			evidence := proposal.Strings("evidenceIds")
			if len(evidence) == 0 {
				t.err = errors.New("analysis_evidence_invalid")
				return false
			}
			for _, id := range evidence {
				if !slices.Contains(valid, id) {
					t.err = errors.New("analysis_evidence_invalid")
					return false
				}
			}
			related := proposal.S("relatedRequirementId")
			var req p.Record
			if related != "" {
				req = t.Get("requirements", related)
				if req == nil {
					t.err = errors.New("analysis_requirement_invalid")
					return false
				}
			}
			sorted := slices.Clone(evidence)
			slices.Sort(sorted)
			id := compat.Hash([]any{proposal.S("category"), strings.TrimSpace(proposal.S("title")), strings.TrimSpace(proposal.S("body")), sorted, related})
			if t.Get("candidates", id) == nil {
				candidate := proposal.With(p.Record{"id": id, "groupId": g.S("id"), "status": "pending", "unread": true, "createdAt": time.Now().UnixMilli(), "revision": 1})
				if req != nil {
					candidate["expectedVersion"] = req.N("version")
				}
				t.Exec("INSERT INTO candidates VALUES(?,?,?)", id, job, string(compat.JSON(candidate)))
			}
		}
	}
	for _, m := range messages {
		t.Exec("UPDATE messages SET analyzed=? WHERE id=? AND version=?", m.S("version"), m.S("id"), m.S("version"))
	}
	return true
}
func (t *Tx) Preview(r p.Record) (p.Record, error) {
	c := t.Get("candidates", r.S("id"))
	if c == nil {
		return nil, errors.New("candidate_missing")
	}
	if c.N("revision") != r.N("revision") && c.S("status") != "accepted" {
		return nil, errors.New("candidate_revision_conflict")
	}
	prev := t.Get("requirements", r.S("relatedRequirementId"))
	if r.S("relatedRequirementId") != "" && prev == nil {
		return nil, errors.New("requirement_missing")
	}
	result := p.Record{"candidate": c, "expectedVersion": prev.N("version"), "next": p.Record{"title": strings.TrimSpace(r.S("title")), "body": strings.TrimSpace(r.S("body")), "version": prev.N("version") + 1}}
	if prev != nil {
		result["previous"] = prev
	}
	return result, nil
}
func (t *Tx) Accept(r p.Record) (p.Record, error) {
	v, e := t.Preview(r)
	if e != nil {
		return nil, e
	}
	c, prev := v.O("candidate"), v.O("previous")
	if c.S("status") == "accepted" {
		if c.S("title") != strings.TrimSpace(r.S("title")) || c.S("body") != strings.TrimSpace(r.S("body")) || c.S("relatedRequirementId") != r.S("relatedRequirementId") {
			return nil, errors.New("candidate_accept_conflict")
		}
		return t.One("SELECT json FROM requirement_versions WHERE id=? AND version=?", c.S("requirementId"), c.N("acceptedVersion")), nil
	}
	if c.S("status") == "ignored" {
		return nil, errors.New("candidate_not_pending")
	}
	if len(prev) > 0 && r.N("expectedVersion") != prev.N("version") {
		return nil, errors.New("requirement_version_conflict")
	}
	now := time.Now().UnixMilli()
	id, number, created := prev.S("id"), prev.N("number"), prev.N("createdAt")
	if id == "" {
		id = ID()
		number = t.Count("SELECT coalesce(max(number),0)+1 FROM requirements")
		created = now
	}
	req := prev.With(p.Record{"id": id, "number": number, "title": v.O("next").S("title"), "body": v.O("next").S("body"), "category": c.S("category"), "version": prev.N("version") + 1, "evidenceIds": p.Unique(append(prev.Strings("evidenceIds"), c.Strings("evidenceIds")...)), "createdAt": created, "updatedAt": now})
	t.Exec("INSERT OR REPLACE INTO requirements VALUES(?,?,?)", id, number, string(compat.JSON(req)))
	t.Exec("INSERT INTO requirement_versions VALUES(?,?,?)", id, req.N("version"), string(compat.JSON(req)))
	t.Exec("DELETE FROM requirement_fts WHERE id=?", id)
	t.Exec("INSERT INTO requirement_fts VALUES(?,?)", id, req.S("title")+"\n"+req.S("body"))
	patch := p.Record{"title": req.S("title"), "body": req.S("body"), "status": "accepted", "unread": false, "requirementId": id, "acceptedVersion": req.N("version"), "revision": c.N("revision") + 1}
	next := c.With(patch)
	if r.S("relatedRequirementId") != "" {
		next["relatedRequirementId"] = r.S("relatedRequirementId")
	} else {
		delete(next, "relatedRequirementId")
	}
	t.Exec("UPDATE candidates SET json=? WHERE id=?", string(compat.JSON(next)), c.S("id"))
	return req, nil
}
func (t *Tx) Attachment(id string) (p.Record, p.Record) {
	for _, m := range t.All("SELECT json FROM messages") {
		for _, a := range m.Records("attachments") {
			if a.S("id") == id {
				return m, a
			}
		}
	}
	return nil, nil
}
func (t *Tx) AttachmentBytes(id string) ([]byte, error) {
	if !hexID(id) {
		return nil, errors.New("attachment_id_invalid")
	}
	root := filepath.Join(t.root, "attachments")
	if e := Regular(filepath.Join(root, id)); e != nil {
		return nil, e
	}
	s, e := os.Lstat(root)
	if e != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("attachment_storage_invalid")
	}
	return ReadFile(filepath.Join(root, id), 8*1024*1024)
}
func hexID(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'f' || c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}
func (t *Tx) UpdateAttachment(id string, patch p.Record) {
	m, _ := t.Attachment(id)
	if m == nil {
		t.err = errors.New("attachment_missing")
		return
	}
	a := m.Records("attachments")
	for i, v := range a {
		if v.S("id") == id {
			a[i] = v.With(patch)
		}
	}
	m["attachments"] = a
	t.Exec("UPDATE messages SET json=? WHERE id=?", string(compat.JSON(m)), m.S("id"))
}
func (t *Tx) SaveAttachment(id string, data []byte, mime string) error {
	if !hexID(id) || len(data) == 0 || len(data) > 8*1024*1024 {
		return errors.New("attachment_size_exceeded")
	}
	_, a := t.Attachment(id)
	if a == nil {
		return errors.New("attachment_missing")
	}
	root := filepath.Join(t.root, "attachments")
	if e := Directory(root); e != nil {
		return e
	}
	if e := Atomic(filepath.Join(root, id), data); e != nil {
		return e
	}
	textual := strings.HasPrefix(mime, "text/") || mime == "application/json" || mime == "application/xml"
	image := slices.Contains([]string{"image/png", "image/jpeg", "image/gif", "image/webp"}, mime)
	supported := textual && utf8.Valid(data) && !strings.ContainsRune(string(data), 0) || image && len(data) <= 2*1024*1024
	patch := p.Record{"state": "ready", "mimeType": mime, "size": len(data), "analysisState": "ready"}
	if !supported {
		patch["analysisState"] = "unsupported"
		patch["analysisNote"] = "原件已保留；自动分析暂不支持此格式、编码或大小（图片上限 2 MiB）"
	}
	t.UpdateAttachment(id, patch)
	return nil
}
func (t *Tx) Handle(kind string, r p.Record) (any, error) {
	switch kind {
	case "messages.list":
		items := t.Messages(r, r.N("limit")+1)
		out := p.Record{"messages": []p.Record{}}
		n := int(r.N("limit"))
		more := len(items) > n
		if more {
			items = items[:n]
		}
		public := []p.Record{}
		for _, m := range items {
			public = append(public, Public(m))
		}
		out["messages"] = public
		if more {
			m := items[len(items)-1]
			out["nextCursor"] = p.Record{"before": m.N("createdAt"), "beforeId": m.S("id")}
		}
		return out, nil
	case "messages.read":
		out := []p.Record{}
		for _, id := range r.Strings("ids") {
			if m := t.Get("messages", id); m != nil {
				out = append(out, Public(m))
			}
		}
		return p.Record{"messages": out}, nil
	case "attachment.read":
		_, a := t.Attachment(r.S("id"))
		if a == nil {
			return nil, errors.New("attachment_missing")
		}
		if a.S("state") == "ready" {
			b, e := t.AttachmentBytes(a.S("id"))
			if e != nil {
				return nil, e
			}
			a["base64"] = base64Bytes(b)
		}
		return a, nil
	case "candidate.read", "candidate.ignore", "candidate.snooze":
		c := t.Get("candidates", r.S("id"))
		if c == nil {
			return nil, errors.New("candidate_missing")
		}
		if c.S("status") == "accepted" && kind != "candidate.read" {
			return nil, errors.New("candidate_already_accepted")
		}
		c["unread"] = false
		if kind != "candidate.read" {
			c["revision"] = c.N("revision") + 1
			if kind == "candidate.ignore" {
				c["status"] = "ignored"
			} else {
				c["status"] = "snoozed"
			}
		}
		t.Exec("UPDATE candidates SET json=? WHERE id=?", string(compat.JSON(c)), c.S("id"))
		return c, nil
	case "candidate.preview":
		return t.Preview(r)
	case "candidate.accept":
		return t.Accept(r)
	case "candidate.list":
		b := r.O("before")
		var before any
		if len(b) > 0 {
			before = b.Float("time")
		}
		items := t.All(`SELECT json FROM candidates WHERE (json_extract(json,'$.status')='pending' OR (?=1 AND json_extract(json,'$.status')='snoozed')) AND (? IS NULL OR json_extract(json,'$.createdAt')<? OR (json_extract(json,'$.createdAt')=? AND id<?)) AND (json_extract(json,'$.title') LIKE ? ESCAPE '\' OR json_extract(json,'$.body') LIKE ? ESCAPE '\') ORDER BY json_extract(json,'$.createdAt') DESC,id DESC LIMIT ?`, r.B("includeSnoozed"), before, before, before, b.S("id"), like(r.S("query")), like(r.S("query")), r.N("limit")+1)
		out := p.Record{"items": items}
		if len(items) > int(r.N("limit")) {
			items = items[:r.N("limit")]
			out["items"] = items
			last := items[len(items)-1]
			out["nextCursor"] = p.Record{"time": last.N("createdAt"), "id": last.S("id")}
		}
		return out, nil
	case "requirement.list":
		var before any
		if _, ok := r["before"]; ok {
			before = r.N("before")
		}
		items := t.All(`SELECT json FROM requirements WHERE (? IS NULL OR number<?) AND (json_extract(json,'$.title') LIKE ? ESCAPE '\' OR json_extract(json,'$.body') LIKE ? ESCAPE '\') ORDER BY number DESC LIMIT ?`, before, before, like(r.S("query")), like(r.S("query")), r.N("limit")+1)
		out := p.Record{"items": items}
		if len(items) > int(r.N("limit")) {
			items = items[:r.N("limit")]
			out["items"] = items
			out["nextCursor"] = items[len(items)-1].N("number")
		}
		return out, nil
	case "requirement.history":
		return t.All("SELECT json FROM requirement_versions WHERE id=? ORDER BY version DESC", r.S("id")), nil
	case "delivery.preview":
		return t.PreviewDelivery(r)
	case "delivery.status":
		d := t.Get("deliveries", r.S("id"))
		if d == nil {
			return nil, errors.New("delivery_missing")
		}
		return d, nil
	case "delivery.targets", "delivery.send":
		return nil, errors.New("delivery_requires_host")
	}
	return nil, fmt.Errorf("invalid_request: %s", kind)
}
