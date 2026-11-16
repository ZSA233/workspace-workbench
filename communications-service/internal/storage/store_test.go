package storage

import (
	"context"
	"github.com/zsa233/workspace-workbench/communications-service/internal/compat"
	p "github.com/zsa233/workspace-workbench/communications-service/internal/protocol"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func copyTree(t *testing.T, src, dst string) {
	t.Helper()
	e := filepath.WalkDir(src, func(path string, d os.DirEntry, e error) error {
		if e != nil {
			return e
		}
		rel, _ := filepath.Rel(src, path)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		b, e := os.ReadFile(path)
		if e != nil {
			return e
		}
		return os.WriteFile(target, b, 0600)
	})
	if e != nil {
		t.Fatal(e)
	}
}
func golden(t *testing.T) p.Record {
	t.Helper()
	b, e := os.ReadFile("../../testdata/node-v1/golden.json")
	if e != nil {
		t.Fatal(e)
	}
	r, e := p.Decode(b)
	if e != nil {
		t.Fatal(e)
	}
	return r
}
func fixtureStore(t *testing.T) (*Store, string) {
	t.Helper()
	home := t.TempDir()
	copyTree(t, "../../testdata/node-v1/home", home)
	s, e := Open(filepath.Join(home, "projects", "legacy-project"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { s.Close() })
	return s, home
}
func do(t *testing.T, s *Store, fn func(*Tx) (any, error)) any {
	t.Helper()
	v, e := s.Do(context.Background(), fn)
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func TestNodeDataCredentialsAndDeliveryIdentity(t *testing.T) {
	s, home := fixtureStore(t)
	g := golden(t)
	vault := &Credentials{Root: filepath.Join(home, "secrets", "legacy-project")}
	key, e := vault.Get("model-key")
	if e != nil || key != "fixture-model-key-中文" {
		t.Fatalf("%q %v", key, e)
	}
	if e = vault.Set("app-secret", "new-go-value"); e != nil {
		t.Fatal(e)
	}
	v, e := vault.Get("app-secret")
	if e != nil || v != "new-go-value" {
		t.Fatal(v, e)
	}
	do(t, s, func(tx *Tx) (any, error) {
		if tx.Meta("unknown-history")["retained"] != true {
			t.Fatal("lost history")
		}
		if tx.Get("groups", "group-one").O("unknown")["retain"] != true {
			t.Fatal("lost unknown group fields")
		}
		if tx.Get("tasks", "interrupted-task").S("state") != "cancelled" || tx.Get("deliveries", "interrupted-delivery").S("state") != "uncertain" {
			t.Fatal("restart state")
		}
		old := g.O("delivery")
		input := p.Record{"requirementId": old.S("requirementId"), "version": old.N("requirementVersion"), "workspaceId": old.S("workspaceId"), "messageIds": old.Strings("messageIds"), "attachmentIds": old.Strings("attachmentIds")}
		d, e := tx.PreviewDelivery(input)
		if e != nil {
			t.Fatal(e)
		}
		if d.S("id") != old.S("id") {
			t.Fatalf("delivery hash changed: %s != %s", d.S("id"), old.S("id"))
		}
		for _, id := range input.Strings("messageIds") {
			if tx.Get("messages", id).S("unknown") != "retain-message" {
				t.Fatal("lost unknown message")
			}
		}
		return nil, nil
	})
	found, e := s.SearchMessages(context.Background(), "需求", 10)
	if e != nil || len(found) == 0 {
		t.Fatal(e, len(found))
	}
	do(t, s, func(tx *Tx) (any, error) {
		rev, c, e := tx.Settings()
		if e != nil {
			t.Fatal(e)
		}
		c.Model.ContextTokens = 524288
		if _, e = tx.Configure(rev, c); e != nil {
			t.Fatal(e)
		}
		if _, e = tx.Configure(rev, c); e == nil {
			t.Fatal("accepted stale revision")
		}
		return nil, nil
	})
}
func TestConcurrentAcceptAndDeliveryDoNotReplay(t *testing.T) {
	s, _ := fixtureStore(t)
	g := golden(t)
	old := g.O("delivery")
	var wg sync.WaitGroup
	var mu sync.Mutex
	claimed := 0
	for range 12 {
		wg.Go(func() {
			v, e := s.Do(context.Background(), func(tx *Tx) (any, error) { return tx.ClaimDelivery(old.S("id")) })
			if e != nil {
				t.Error(e)
				return
			}
			if v.(p.Record).B("claimed") {
				mu.Lock()
				claimed++
				mu.Unlock()
			}
		})
	}
	wg.Wait()
	if claimed != 1 {
		t.Fatal(claimed)
	}
	do(t, s, func(tx *Tx) (any, error) {
		if _, e := tx.FinishDelivery(old.S("id"), p.Record{"delivery": "accepted", "messageId": "receipt"}); e != nil {
			return nil, e
		}
		d, e := tx.FinishDelivery(old.S("id"), p.Record{"delivery": "uncertain"})
		if e != nil || d.S("state") != "accepted" {
			t.Fatal(d, e)
		}
		return nil, nil
	})
}
func TestIngestFencesEditsPaginationAndAttachments(t *testing.T) {
	s, _ := fixtureStore(t)
	do(t, s, func(tx *Tx) (any, error) {
		g := tx.Get("groups", "group-one")
		for i := 0; i < 3; i++ {
			m := p.Record{"id": strings.Repeat(string(rune('a'+i)), 64), "sourceId": "same-time", "groupId": "group-one", "createdAt": 1700000020000, "updatedAt": 1700000020000, "version": "v1", "text": "普通消息", "mentions": []string{}, "attachments": []p.Record{}}
			if tx.Ingest([]p.Message{m}, "group-one", g.N("generation")+1) != 0 {
				t.Fatal("stale generation")
			}
			if tx.Ingest([]p.Message{m}, "group-one", g.N("generation")) != 1 {
				t.Fatal("not ingested")
			}
			if tx.Ingest([]p.Message{m}, "group-one", g.N("generation")) != 0 {
				t.Fatal("duplicate")
			}
			old := m.With(p.Record{"version": "stale", "updatedAt": 1690000000000})
			if tx.Ingest([]p.Message{old}, "group-one", g.N("generation")) != 0 {
				t.Fatal("out of order")
			}
		}
		first := tx.Messages(p.Record{}, 2)
		next := tx.Messages(p.Record{"before": first[1].N("createdAt"), "beforeId": first[1].S("id")}, 2)
		if len(next) < 1 || next[0].S("id") == first[1].S("id") {
			t.Fatal("pagination")
		}
		path := filepath.Join(tx.root, "attachments", strings.Repeat("d", 64))
		if e := os.Symlink(filepath.Join(tx.root, "communications.sqlite"), path); e != nil {
			return nil, e
		}
		if _, e := tx.AttachmentBytes(strings.Repeat("d", 64)); e == nil {
			t.Fatal("accepted symlink")
		}
		return nil, nil
	})
}
func TestLeaseAndAtomicCredentials(t *testing.T) {
	home := t.TempDir()
	release, e := AcquireLease(home)
	if e != nil {
		t.Fatal(e)
	}
	if other, e := AcquireLease(home); e == nil {
		other()
		t.Fatal("double lease")
	}
	release()
	other, e := AcquireLease(home)
	if e != nil {
		t.Fatal(e)
	}
	other()
	c := &Credentials{Root: filepath.Join(home, "secrets")}
	for _, s := range []string{"model-key", "app-secret"} {
		if e = c.Set(s, "秘密😀"); e != nil {
			t.Fatal(e)
		}
		b, _ := os.ReadFile(filepath.Join(c.Root, s+".enc"))
		if strings.Contains(string(b), "秘密") {
			t.Fatal("plaintext")
		}
	}
}
func BenchmarkBacklogSnapshotAndSearch(b *testing.B) {
	s, e := Open(b.TempDir())
	if e != nil {
		b.Fatal(e)
	}
	defer s.Close()
	_, e = s.Do(context.Background(), func(tx *Tx) (any, error) {
		tx.Save("groups", p.Record{"id": "g", "enabled": true, "generation": 1, "boundAt": 0, "membership": p.Record{"state": "verified"}})
		messages := []p.Record{}
		for i := 0; i < 10000; i++ {
			messages = append(messages, p.Record{"id": compat.Hash(i), "groupId": "g", "text": "需求检索 benchmark backlog", "createdAt": time.Now().UnixMilli() + int64(i), "updatedAt": 1, "version": "v1", "attachments": []p.Record{}})
		}
		tx.Ingest(messages, "g", 1)
		return nil, nil
	})
	if e != nil {
		b.Fatal(e)
	}
	b.ResetTimer()
	for b.Loop() {
		_, e := s.Do(context.Background(), func(tx *Tx) (any, error) { _ = tx.Snapshot(); return tx.Messages(p.Record{"query": "需求"}, 50), nil })
		if e != nil {
			b.Fatal(e)
		}
	}
}

func TestReviewedRequirementVersionsAndDuplicateAnalysis(t *testing.T) {
	s, _ := fixtureStore(t)
	g := golden(t)
	req := g.O("requirement")
	do(t, s, func(tx *Tx) (any, error) {
		messages := tx.Pending("group-one")
		if len(messages) != 0 {
			t.Fatal("old messages reanalyzed")
		}
		m := p.Record{"id": strings.Repeat("e", 64), "groupId": "group-one", "createdAt": 1700000030000, "updatedAt": 1700000030000, "version": "v1", "text": "增加日期", "attachments": []p.Record{}}
		tx.Ingest([]p.Message{m}, "group-one", 1)
		proposal := p.Record{"title": "增加日期", "body": "导出支持日期范围", "category": "change", "evidenceIds": []string{m.S("id")}, "relatedRequirementId": req.S("id"), "uncertainty": ""}
		if !tx.RecordAnalysis("second-job", []p.Record{m}, []p.Record{proposal}, 1) {
			t.Fatal("no analysis")
		}
		if !tx.RecordAnalysis("second-job", []p.Record{m}, []p.Record{proposal}, 1) {
			t.Fatal("retry")
		}
		if tx.Count("SELECT count(*) FROM candidates WHERE job_id='second-job'") != 1 {
			t.Fatal("duplicate candidate")
		}
		candidate := tx.One("SELECT json FROM candidates WHERE job_id='second-job'")
		input := p.Record{"id": candidate.S("id"), "revision": candidate.N("revision"), "title": candidate.S("title"), "body": candidate.S("body"), "relatedRequirementId": req.S("id"), "expectedVersion": 0}
		if _, e := tx.Accept(input); e == nil {
			t.Fatal("accepted stale requirement")
		}
		input["expectedVersion"] = req.N("version")
		updated, e := tx.Accept(input)
		if e != nil {
			t.Fatal(e)
		}
		if updated.N("version") != 2 {
			t.Fatal(updated)
		}
		again, e := tx.Accept(input)
		if e != nil || again.N("version") != 2 {
			t.Fatal(again, e)
		}
		history := tx.All("SELECT json FROM requirement_versions WHERE id=? ORDER BY version", req.S("id"))
		if len(history) != 2 || history[0].S("body") != req.S("body") {
			t.Fatal("history overwritten")
		}
		return nil, nil
	})
}
