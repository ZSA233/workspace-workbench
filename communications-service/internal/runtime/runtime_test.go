package runtime

import (
	"context"
	"errors"
	"fmt"
	p "github.com/zsa233/workspace-workbench/communications-service/internal/protocol"
	"github.com/zsa233/workspace-workbench/communications-service/internal/providers"
	"github.com/zsa233/workspace-workbench/communications-service/internal/storage"
	"os"
	"os/exec"
	"path/filepath"
	goruntime "runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"
)

type fixtureSource struct {
	mu                     sync.Mutex
	pages                  []providers.SourcePage
	member                 bool
	memberErr              error
	status                 p.Record
	receive                func(p.Message)
	reads, stopped, closed int
	block                  <-chan struct{}
	readStarted            chan struct{}
}

func source() *fixtureSource {
	return &fixtureSource{member: true, status: p.Record{"installed": true, "version": "1.0.68", "authenticated": true, "state": "ready", "identity": p.Record{"profile": "corp:user", "corpId": "corp", "userId": "user"}, "capabilities": p.Record{"messages": p.Pending(), "history": p.Pending(), "attachments": p.Pending()}}}
}
func (f *fixtureSource) Check(context.Context) (p.Record, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.status.Clone(), nil
}
func (f *fixtureSource) Authorize(context.Context, func(string)) error { return nil }
func (f *fixtureSource) SearchGroups(context.Context, string) ([]p.Record, error) {
	return []p.Record{{"id": "g", "name": "项目群"}}, nil
}
func (f *fixtureSource) VerifyMembership(context.Context, p.Group) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.member, f.memberErr
}
func (f *fixtureSource) Read(_ context.Context, _ p.Group, _ int64, _ int64, _ string) (providers.SourcePage, error) {
	f.mu.Lock()
	f.reads++
	block := f.block
	started := f.readStarted
	page := providers.SourcePage{Complete: true, Messages: []p.Message{}}
	if len(f.pages) > 0 {
		page = f.pages[0]
		f.pages = f.pages[1:]
	}
	f.mu.Unlock()
	if started != nil {
		select {
		case started <- struct{}{}:
		default:
		}
	}
	if block != nil {
		<-block
	}
	return page, nil
}
func (f *fixtureSource) Subscribe(_ context.Context, _ p.Group, receive func(p.Message), ready func(), _ func(error)) (func(), error) {
	f.mu.Lock()
	f.receive = receive
	f.mu.Unlock()
	ready()
	return func() { f.mu.Lock(); f.stopped++; f.mu.Unlock() }, nil
}
func (f *fixtureSource) Download(context.Context, p.Message, p.Record) ([]byte, string, error) {
	return []byte("附件原始内容"), "text/plain", nil
}
func (f *fixtureSource) Close() { f.mu.Lock(); f.closed++; f.mu.Unlock() }

type fixtureAnalysis struct {
	block <-chan struct{}

	mu    sync.Mutex
	calls int
	fail  bool
	seen  []providers.AnalysisInput
}

func (f *fixtureAnalysis) Models(context.Context) ([]p.Record, error) {
	return []p.Record{{"id": "fixture", "contextTokens": 524288}}, nil
}
func (f *fixtureAnalysis) Check(context.Context) error { return nil }
func (f *fixtureAnalysis) Analyze(ctx context.Context, input providers.AnalysisInput) (providers.AnalysisResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	f.seen = append(f.seen, input)
	if f.block != nil {
		block := f.block
		f.mu.Unlock()
		select {
		case <-block:
		case <-ctx.Done():
		}
		f.mu.Lock()
		if ctx.Err() != nil {
			return providers.AnalysisResult{}, ctx.Err()
		}
	}
	if f.fail {
		return providers.AnalysisResult{}, errors.New("model_unavailable")
	}
	ids := []string{}
	for _, m := range input.Messages {
		ids = append(ids, m.S("id"))
	}
	return providers.AnalysisResult{Proposals: []p.Candidate{{"title": "保留筛选", "body": "导出应保留筛选条件", "category": "requirement", "evidenceIds": ids, "uncertainty": ""}}, Summary: "讨论摘要", EstimatedTokens: 100}, nil
}
func group() p.Group {
	return p.Group{"id": "g", "name": "项目群", "identity": "corp:user", "boundAt": 1000, "checkpoint": 1000, "generation": 1, "enabled": true, "membership": p.Record{"state": "verified"}, "stream": p.Pending(), "history": p.Pending(), "status": "pending"}
}
func message(id string) p.Message {
	return p.Message{"id": id, "sourceId": id, "groupId": "g", "senderId": "user-2", "sender": "开发者", "text": "保留筛选条件", "createdAt": 2000, "updatedAt": 2000, "version": "v1", "mentions": []string{}, "attachments": []p.Record{}}
}
func rig(t *testing.T, root string, f *fixtureSource, a *fixtureAnalysis) *Runtime {
	t.Helper()
	if root == "" {
		root = t.TempDir()
	}
	r, e := New(Options{Root: filepath.Join(root, "data"), Credentials: &storage.Credentials{Root: filepath.Join(root, "secrets")}, Background: true, SourceFactory: func() providers.SourceProvider { return f }, Analysis: a, Now: func() time.Time { return time.UnixMilli(100000) }})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(r.Close)
	r.sourceStatus = f.status.Clone()
	return r
}
func data(t *testing.T, r *Runtime, fn func(*storage.Tx) (any, error)) any {
	t.Helper()
	v, e := r.Store.Do(context.Background(), fn)
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func action(t *testing.T, r *Runtime, q p.Record) any {
	t.Helper()
	a, e := p.ParseAction(q)
	if e != nil {
		t.Fatal(e)
	}
	v, e := r.Handle(context.Background(), a)
	if e != nil {
		t.Fatal(e)
	}
	return v
}
func until(t *testing.T, r *Runtime, check func() bool) {
	t.Helper()
	end := time.Now().Add(4 * time.Second)
	for !check() {
		if time.Now().After(end) {
			t.Fatal("condition timed out")
		}
		r.Tick()
		time.Sleep(10 * time.Millisecond)
	}
}
func TestOrdinaryLiveDuplicateAndOfflineSelfMessages(t *testing.T) {
	f, a := source(), &fixtureAnalysis{}
	one, self := message("one"), message("self")
	self["senderId"] = "user"
	f.pages = []providers.SourcePage{{Messages: []p.Message{one, self}, Complete: true}}
	r := rig(t, "", f, a)
	data(t, r, func(tx *storage.Tx) (any, error) { tx.Save("groups", group()); return nil, nil })
	until(t, r, func() bool { s, _ := r.Snapshot(); return s.N("messageCount") == 2 })
	f.mu.Lock()
	receive := f.receive
	f.mu.Unlock()
	receive(one)
	receive(message("live"))
	s, e := r.Snapshot()
	if e != nil || s.N("messageCount") != 3 {
		t.Fatal(s, e)
	}
	data(t, r, func(tx *storage.Tx) (any, error) {
		if tx.Get("groups", "g").N("checkpoint") != 100000 {
			t.Fatal("checkpoint")
		}
		if tx.Get("messages", "self").S("senderId") != "user" {
			t.Fatal("missed self message")
		}
		return nil, nil
	})
}
func TestIncompleteWindowResumesAfterRestart(t *testing.T) {
	root := t.TempDir()
	f := source()
	f.pages = []providers.SourcePage{{Messages: []p.Message{message("one")}, Cursor: "page-two", Complete: false}}
	r := rig(t, root, f, &fixtureAnalysis{})
	data(t, r, func(tx *storage.Tx) (any, error) { tx.Save("groups", group()); return nil, nil })
	if e := r.syncGroup(r.current, context.Background(), group()); e != nil {
		t.Fatal(e)
	}
	s, _ := r.Snapshot()
	g := s.Records("groups")[0]
	if g.N("checkpoint") != 1000 || g.S("cursor") != "page-two" || g.O("window").N("end") != 100000 {
		t.Fatal(g)
	}
	r.Close()
	f2 := source()
	f2.pages = []providers.SourcePage{{Messages: []p.Message{message("two")}, Complete: true}}
	r2 := rig(t, root, f2, &fixtureAnalysis{})
	if e := r2.syncGroup(r2.current, context.Background(), g); e != nil {
		t.Fatal(e)
	}
	s, _ = r2.Snapshot()
	g = s.Records("groups")[0]
	if g.N("checkpoint") != 100000 || g.S("cursor") != "" || s.N("messageCount") != 2 {
		t.Fatal(g, s.N("messageCount"))
	}
}
func TestMembershipUnknownOrDepartedNeverIngests(t *testing.T) {
	for _, err := range []error{nil, errors.New("membership_unknown")} {
		t.Run("membership", func(t *testing.T) {
			f := source()
			f.member = false
			f.memberErr = err
			f.pages = []providers.SourcePage{{Messages: []p.Message{message("bad")}, Complete: true}}
			r := rig(t, "", f, &fixtureAnalysis{})
			data(t, r, func(tx *storage.Tx) (any, error) { tx.Save("groups", group()); return nil, nil })
			if e := r.syncGroup(r.current, context.Background(), group()); e == nil {
				t.Fatal("allowed collection")
			}
			s, _ := r.Snapshot()
			if s.N("messageCount") != 0 || s.Records("groups")[0].S("status") != "paused" {
				t.Fatal(s)
			}
		})
	}
}
func TestPauseAndConfigurationFenceLateHistory(t *testing.T) {
	for _, operation := range []string{"pause", "configure", "close"} {
		t.Run(operation, func(t *testing.T) {
			f := source()
			block := make(chan struct{})
			f.block = block
			f.readStarted = make(chan struct{}, 1)
			f.pages = []providers.SourcePage{{Messages: []p.Message{message("late")}, Complete: true}}
			r := rig(t, "", f, &fixtureAnalysis{})
			data(t, r, func(tx *storage.Tx) (any, error) { tx.Save("groups", group()); return nil, nil })
			r.Tick()
			select {
			case <-f.readStarted:
			case <-time.After(time.Second):
				t.Fatal("read not started")
			}
			oldEpoch := r.current
			done := make(chan struct{})
			go func() {
				defer close(done)
				switch operation {
				case "pause":
					action(t, r, p.Record{"action": "groups.pause", "groupId": "g"})
				case "configure":
					s, _ := r.Snapshot()
					action(t, r, p.Record{"action": "configure", "revision": s.N("revision"), "config": s["config"]})
				case "close":
					r.Close()
				}
			}()
			deadline := time.Now().Add(time.Second)
			for {
				r.mu.Lock()
				changed := r.closed || r.current != oldEpoch
				r.mu.Unlock()
				if operation == "pause" {
					value, e := r.Store.Do(context.Background(), func(tx *storage.Tx) (any, error) { return !tx.Get("groups", "g").B("enabled"), nil })
					changed = e == nil && value == true
				}
				if changed {
					break
				}
				if time.Now().After(deadline) {
					t.Error("lifecycle did not invalidate old generation")
					break
				}
				time.Sleep(time.Millisecond)
			}
			close(block)
			select {
			case <-done:
			case <-time.After(2 * time.Second):
				t.Fatal("lifecycle did not drain")
			}
			if operation == "close" {
				if _, e := r.Snapshot(); e == nil {
					t.Fatal("closed runtime accessible")
				}
			} else {
				s, _ := r.Snapshot()
				if s.N("messageCount") != 0 {
					t.Fatal("late result persisted", s)
				}
			}
		})
	}
}
func TestModelFailureRetryAndAttachmentEvidence(t *testing.T) {
	f, a := source(), &fixtureAnalysis{fail: true}
	r := rig(t, "", f, a)
	m := message("with-file")
	m["attachments"] = []p.Record{{"id": strings64("a"), "sourceId": "file", "name": "需求.txt", "mimeType": "text/plain", "state": "pending"}}
	f.pages = []providers.SourcePage{{Messages: []p.Message{m}, Complete: true}}
	data(t, r, func(tx *storage.Tx) (any, error) {
		tx.Save("groups", group())
		cfg := p.Defaults()
		cfg.Model.Model = "fixture"
		cfg.Analysis.CoalesceSeconds = 1
		_, e := tx.Configure(1, cfg)
		r.cfgMu.Lock()
		r.config = cfg
		r.cfgMu.Unlock()
		return nil, e
	})
	until(t, r, func() bool { a.mu.Lock(); defer a.mu.Unlock(); return a.calls > 0 })
	until(t, r, func() bool { r.mu.Lock(); defer r.mu.Unlock(); return !r.current.analyzing })
	s, _ := r.Snapshot()
	if s.N("messageCount") != 1 || s.N("analysisPending") != 1 || s.N("pending") != 0 {
		t.Fatal(s)
	}
	a.mu.Lock()
	a.fail = false
	a.mu.Unlock()
	action(t, r, p.Record{"action": "analysis.retry"})
	until(t, r, func() bool { s, _ := r.Snapshot(); return s.N("pending") == 1 && s.N("analysisPending") == 0 })
	a.mu.Lock()
	defer a.mu.Unlock()
	if len(a.seen) == 0 || !contains(a.seen[len(a.seen)-1].Messages[0].S("text"), "附件原始内容") {
		t.Fatal("missing attachment evidence")
	}
}
func strings64(s string) string {
	out := ""
	for range 64 {
		out += s
	}
	return out
}
func contains(s, part string) bool {
	for i := 0; i+len(part) <= len(s); i++ {
		if s[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
func TestAuthorizationLossRetiresStreamsAndAccountChangeRequiresBinding(t *testing.T) {
	f := source()
	r := rig(t, "", f, &fixtureAnalysis{})
	data(t, r, func(tx *storage.Tx) (any, error) { tx.Save("groups", group()); return nil, nil })
	if e := r.syncGroup(r.current, context.Background(), group()); e != nil {
		t.Fatal(e)
	}
	f.mu.Lock()
	oldReceive := f.receive
	f.status["authenticated"] = false
	f.mu.Unlock()
	if _, e := r.checkSource(r.current, context.Background()); e != nil {
		t.Fatal(e)
	}
	oldReceive(message("after-auth-loss"))
	s, _ := r.Snapshot()
	if s.N("messageCount") != 0 {
		t.Fatal("unauthorized live event")
	}
	f.mu.Lock()
	f.status["authenticated"] = true
	f.status["identity"] = p.Record{"profile": "corp:another", "corpId": "corp", "userId": "another"}
	f.mu.Unlock()
	if _, e := r.checkSource(r.current, context.Background()); e != nil {
		t.Fatal(e)
	}
	s, _ = r.Snapshot()
	if s.Records("groups")[0].B("enabled") {
		t.Fatal("inherited another identity")
	}
}

func TestBacklogMetricsWhileAnalysisWaits(t *testing.T) {
	f, a := source(), &fixtureAnalysis{}
	block := make(chan struct{})
	a.block = block
	r := rig(t, "", f, a)
	data(t, r, func(tx *storage.Tx) (any, error) {
		tx.Save("groups", group())
		cfg := p.Defaults()
		cfg.Model.Model = "fixture"
		cfg.Analysis.CoalesceSeconds = 1
		_, e := tx.Configure(1, cfg)
		r.cfgMu.Lock()
		r.config = cfg
		r.cfgMu.Unlock()
		batch := []p.Message{}
		for i := 0; i < 10000; i++ {
			m := message(fmt.Sprintf("backlog-%05d", i))
			batch = append(batch, m)
		}
		tx.Ingest(batch, "g", 1)
		return nil, e
	})
	r.Tick()
	until(t, r, func() bool { a.mu.Lock(); defer a.mu.Unlock(); return a.calls > 0 })
	durations := []time.Duration{}
	for range 100 {
		start := time.Now()
		if _, e := r.Snapshot(); e != nil {
			t.Fatal(e)
		}
		if _, e := r.Store.SearchMessages(context.Background(), "筛选", 50); e != nil {
			t.Fatal(e)
		}
		durations = append(durations, time.Since(start))
	}
	slices.Sort(durations)
	var memory goruntime.MemStats
	goruntime.ReadMemStats(&memory)
	rss := "unavailable"
	if b, e := exec.Command("ps", "-o", "rss=", "-p", fmt.Sprint(os.Getpid())).Output(); e == nil {
		rss = strings.TrimSpace(string(b))
	}
	recovery := time.Now()
	close(block)
	until(t, r, func() bool { s, _ := r.Snapshot(); return s.N("analysisPending") < 10000 })
	t.Logf("load_metrics backlog=10000 analysis=fixture-waiting snapshot+search_p50_ms=%.3f snapshot+search_p95_ms=%.3f heap_mib=%.2f test_process_rss_kib=%s resume_ms=%.3f", float64(durations[49])/float64(time.Millisecond), float64(durations[94])/float64(time.Millisecond), float64(memory.HeapAlloc)/(1024*1024), rss, float64(time.Since(recovery))/float64(time.Millisecond))
}

func TestProvidersRetainTheirOwnEndpointAndCredentialSnapshot(t *testing.T) {
	root := t.TempDir()
	credentials := &storage.Credentials{Root: filepath.Join(root, "secrets")}
	if e := credentials.Set("model-key", "old-key"); e != nil {
		t.Fatal(e)
	}
	r, e := New(Options{Root: filepath.Join(root, "data"), Credentials: credentials, Background: false})
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	oldModel := r.current.analysis.(*providers.Model)
	oldSource := r.current.source.(*providers.DWS)
	s, e := r.Snapshot()
	if e != nil {
		t.Fatal(e)
	}
	cfg := r.Config()
	cfg.Model.BaseURL = "http://new-model.example/v1"
	cfg.Source.ClientID = "new-app"
	action(t, r, p.Record{"action": "configure", "revision": s.N("revision"), "config": cfg.Record(), "modelKey": "new-key", "appSecret": "new-secret"})
	oldKey, e := oldModel.Key()
	if e != nil || oldKey != "old-key" || oldModel.Config().Model.BaseURL != "http://127.0.0.1:12345/v1" {
		t.Fatal("old model mixed settings", e)
	}
	if oldSource.Config().Source.ClientID != "" {
		t.Fatal("old source mixed app identity")
	}
	newModel := r.current.analysis.(*providers.Model)
	newKey, e := newModel.Key()
	if e != nil || newKey != "new-key" || newModel.Config().Model.BaseURL != cfg.Model.BaseURL {
		t.Fatal("new settings not applied", e)
	}
}
