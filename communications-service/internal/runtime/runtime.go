// Package runtime owns project background work independently of every UI client.
package runtime

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/zsa233/workspace-workbench/communications-service/internal/compat"
	p "github.com/zsa233/workspace-workbench/communications-service/internal/protocol"
	"github.com/zsa233/workspace-workbench/communications-service/internal/providers"
	"github.com/zsa233/workspace-workbench/communications-service/internal/storage"
)

type Options struct {
	Root          string
	Credentials   *storage.Credentials
	Background    bool
	Limits        *providers.Limits
	SourceFactory func() providers.SourceProvider
	Analysis      providers.AnalysisProvider
	Now           func() time.Time
}
type epoch struct {
	ctx                context.Context
	cancel             context.CancelFunc
	wg                 sync.WaitGroup
	source             providers.SourceProvider
	tasks              map[string]p.Task
	groups             map[string]context.CancelFunc
	streams            map[string]func()
	dirty              map[string]bool
	syncing, analyzing bool
	analysis           providers.AnalysisProvider
}
type Runtime struct {
	Store                    *storage.Store
	credentials              *storage.Credentials
	limits                   *providers.Limits
	sourceFactory            func() providers.SourceProvider
	analysisFactory          func() providers.AnalysisProvider
	now                      func() time.Time
	mu                       sync.Mutex
	opMu                     sync.Mutex
	cfgMu                    sync.RWMutex
	config                   p.Config
	sourceStatus             p.Record
	current                  *epoch
	closed                   bool
	background               bool
	ctx                      context.Context
	cancel                   context.CancelFunc
	loop                     sync.WaitGroup
	lastCheck, analysisAfter int64
	started                  bool
}

func New(o Options) (*Runtime, error) {
	s, e := storage.Open(o.Root)
	if e != nil {
		return nil, e
	}
	v, e := s.Do(context.Background(), func(t *storage.Tx) (any, error) { _, c, e := t.Settings(); return c, e })
	if e != nil {
		s.Close()
		return nil, e
	}
	if o.Limits == nil {
		o.Limits = providers.NewLimits()
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &Runtime{Store: s, credentials: o.Credentials, limits: o.Limits, config: v.(p.Config), sourceStatus: p.EmptySource(), now: o.Now, background: o.Background, ctx: ctx, cancel: cancel}
	r.sourceFactory = o.SourceFactory
	if r.sourceFactory == nil {
		r.sourceFactory = func() providers.SourceProvider {
			cfg := r.Config()
			secret, e := r.credentials.Get("app-secret")
			return providers.NewDWS(o.Root, func() p.Config { return cfg }, func() (string, error) { return secret, e }, o.Limits)
		}
	}
	r.analysisFactory = func() providers.AnalysisProvider {
		if o.Analysis != nil {
			return o.Analysis
		}
		cfg := r.Config()
		key, e := r.credentials.Get("model-key")
		return providers.NewModel(func() p.Config { return cfg }, func() (string, error) { return key, e }, o.Limits)
	}
	r.current = r.newEpoch()
	if !r.background {
		r.sourceStatus["detail"] = "项目后台任务已暂停，已有消息与需求仍可查看"
	}
	return r, nil
}
func (r *Runtime) newEpoch() *epoch {
	ctx, cancel := context.WithCancel(r.ctx)
	return &epoch{ctx: ctx, cancel: cancel, source: r.sourceFactory(), analysis: r.analysisFactory(), tasks: map[string]p.Task{}, groups: map[string]context.CancelFunc{}, streams: map[string]func(){}, dirty: map[string]bool{}}
}
func (r *Runtime) Config() p.Config {
	r.cfgMu.RLock()
	defer r.cfgMu.RUnlock()
	c := r.config
	c.Analysis.Categories = slices.Clone(c.Analysis.Categories)
	c.Analysis.Keywords = slices.Clone(c.Analysis.Keywords)
	c.Analysis.FocusPeople = slices.Clone(c.Analysis.FocusPeople)
	return c
}
func (r *Runtime) Start() {
	r.mu.Lock()
	if r.closed || !r.background || r.started {
		r.mu.Unlock()
		return
	}
	r.started = true
	r.loop.Add(1)
	r.lastCheck = 0
	r.mu.Unlock()
	go func() {
		defer r.loop.Done()
		ticker := time.NewTicker(time.Second)
		defer ticker.Stop()
		r.Tick()
		for {
			select {
			case <-r.ctx.Done():
				return
			case <-ticker.C:
				r.Tick()
			}
		}
	}()
}
func (r *Runtime) data(ctx context.Context, fn func(*storage.Tx) (any, error)) (any, error) {
	return r.Store.Do(ctx, fn)
}
func (r *Runtime) taskLocked(ep *epoch, kind, group string, run func(context.Context, func(p.Record)) (any, error)) p.Task {
	key := kind + ":" + group
	if old := ep.tasks[key]; old != nil {
		return old.Clone()
	}
	now := r.now().UnixMilli()
	task := p.Task{"id": storage.ID(), "kind": kind, "state": "running", "createdAt": now, "updatedAt": now}
	if group != "" {
		task["groupId"] = group
	}
	ep.tasks[key] = task
	if _, err := r.data(context.Background(), func(t *storage.Tx) (any, error) { t.SaveTask(task); return nil, nil }); err != nil {
		delete(ep.tasks, key)
		if kind == "sync" {
			ep.syncing = false
		}
		if kind == "analysis" {
			ep.analyzing = false
		}
		return task.With(p.Record{"state": "failed", "error": err.Error()})
	}
	ep.wg.Add(1)
	go func() {
		defer ep.wg.Done()
		update := func(patch p.Record) {
			r.mu.Lock()
			defer r.mu.Unlock()
			if r.closed || r.current != ep {
				return
			}
			task = task.With(patch)
			task["updatedAt"] = r.now().UnixMilli()
			ep.tasks[key] = task
			r.data(context.Background(), func(t *storage.Tx) (any, error) { t.SaveTask(task); return nil, nil })
		}
		v, e := run(ep.ctx, update)
		if e != nil {
			state := "failed"
			if ep.ctx.Err() != nil {
				state = "cancelled"
			}
			update(p.Record{"state": state, "error": e.Error()})
		} else {
			update(p.Record{"state": "complete", "result": v})
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		delete(ep.tasks, key)
		if kind == "sync" {
			ep.syncing = false
		}
		if kind == "analysis" {
			ep.analyzing = false
		}
	}()
	return task.Clone()
}
func (r *Runtime) Snapshot() (p.Record, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return nil, errors.New("extension_stopped")
	}
	v, e := r.data(context.Background(), func(t *storage.Tx) (any, error) { return t.Snapshot(), nil })
	if e != nil {
		return nil, e
	}
	model, e := r.credentials.Get("model-key")
	if e != nil {
		return nil, e
	}
	secret, e := r.credentials.Get("app-secret")
	if e != nil {
		return nil, e
	}
	out := v.(p.Record)
	out["source"] = r.sourceStatus.Clone()
	out["credentials"] = p.Record{"modelKey": model != "", "appSecret": secret != ""}
	out["background"] = "paused"
	if r.background {
		out["background"] = "running"
	}
	return out, nil
}
func (r *Runtime) commit(ep *epoch, id string, generation int64, fn func(*storage.Tx, p.Group) (any, error)) (any, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || r.current != ep || ep.ctx.Err() != nil {
		return nil, context.Canceled
	}
	return r.data(ep.ctx, func(t *storage.Tx) (any, error) {
		g := t.Get("groups", id)
		if g == nil || !g.B("enabled") || g.N("generation") != generation {
			return nil, context.Canceled
		}
		return fn(t, g)
	})
}
func (r *Runtime) checkSource(ep *epoch, ctx context.Context) (any, error) {
	status, e := ep.source.Check(ctx)
	if e != nil {
		return nil, e
	}
	r.mu.Lock()
	if r.closed || r.current != ep || ctx.Err() != nil {
		r.mu.Unlock()
		return nil, context.Canceled
	}
	r.sourceStatus = status.Clone()
	stops := []func(){}
	_, e = r.data(ctx, func(t *storage.Tx) (any, error) {
		for _, g := range t.Groups() {
			if !g.B("enabled") {
				continue
			}
			changed := g.S("identity") != "" && status.O("identity").S("profile") != "" && g.S("identity") != status.O("identity").S("profile")
			if status.B("authenticated") && !changed {
				continue
			}
			patch := p.Record{"generation": g.N("generation") + 1, "status": "paused", "membership": p.Pending(), "error": "待授权，采集已暂停"}
			if changed {
				patch["enabled"] = false
				patch["error"] = "账号身份改变，请重新绑定"
			}
			next := g.With(patch)
			delete(next, "lastCheckedAt")
			t.Save("groups", next)
			if stop := ep.streams[g.S("id")]; stop != nil {
				stops = append(stops, stop)
				delete(ep.streams, g.S("id"))
			}
			if cancel := ep.groups[g.S("id")]; cancel != nil {
				cancel()
				delete(ep.groups, g.S("id"))
			}
		}
		return nil, nil
	})
	r.mu.Unlock()
	for _, stop := range stops {
		stop()
	}
	return status, e
}
func (r *Runtime) Tick() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed || !r.background {
		return
	}
	ep := r.current
	now := r.now().UnixMilli()
	interval := int64(60000)
	if r.sourceStatus.B("authenticated") {
		interval = 600000
	}
	if r.lastCheck == 0 || now-r.lastCheck >= interval {
		r.lastCheck = now
		r.taskLocked(ep, "connection", "", func(ctx context.Context, _ func(p.Record)) (any, error) { return r.checkSource(ep, ctx) })
	}
	v, e := r.data(ep.ctx, func(t *storage.Tx) (any, error) { return t.Groups(), nil })
	if e != nil {
		return
	}
	groups := v.([]p.Group)
	slices.SortStableFunc(groups, func(a, b p.Group) int {
		if a.N("lastCheckedAt") < b.N("lastCheckedAt") {
			return -1
		}
		if a.N("lastCheckedAt") > b.N("lastCheckedAt") {
			return 1
		}
		return strings.Compare(a.S("id"), b.S("id"))
	})
	cfg := r.Config()
	if !ep.syncing && r.sourceStatus.B("authenticated") {
		for _, g := range groups {
			if !g.B("enabled") {
				continue
			}
			if ep.dirty[g.S("id")] || g["lastCheckedAt"] == nil || now-g.N("lastCheckedAt") >= int64(cfg.Analysis.ReconcileSeconds)*1000 || (g.S("cursor") != "" && g.S("status") == "partial" && g.S("error") == "") {
				ep.syncing = true
				delete(ep.dirty, g.S("id"))
				r.taskLocked(ep, "sync", g.S("id"), func(ctx context.Context, _ func(p.Record)) (any, error) { return nil, r.syncGroup(ep, ctx, g) })
				break
			}
		}
	}
	if !ep.analyzing && cfg.Analysis.Enabled && cfg.Model.Model != "" && now >= r.analysisAfter {
		for _, g := range groups {
			if !g.B("enabled") || g.O("membership").S("state") != "verified" {
				continue
			}
			v, e := r.data(ep.ctx, func(t *storage.Tx) (any, error) { return t.Pending(g.S("id")), nil })
			if e != nil {
				continue
			}
			messages := v.([]p.Message)
			newest := int64(0)
			ready := len(messages) > 0
			for _, m := range messages {
				newest = max(newest, m.N("createdAt"))
				for _, a := range m.Records("attachments") {
					if a.S("state") == "pending" {
						ready = false
						ep.dirty[g.S("id")] = true
					}
				}
			}
			if ready && now-newest >= int64(cfg.Analysis.CoalesceSeconds)*1000 {
				ep.analyzing = true
				r.taskLocked(ep, "analysis", g.S("id"), func(ctx context.Context, _ func(p.Record)) (any, error) { return r.analyze(ep, ctx, g) })
				break
			}
		}
	}
}
func (r *Runtime) syncGroup(ep *epoch, parent context.Context, initial p.Group) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	id, gen := initial.S("id"), initial.N("generation")
	r.mu.Lock()
	if r.current != ep || r.closed {
		r.mu.Unlock()
		return context.Canceled
	}
	ep.groups[id] = cancel
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(ep.groups, id); r.mu.Unlock() }()
	member, e := ep.source.VerifyMembership(ctx, initial)
	if e == nil && !member {
		e = errors.New("机器人已离群，已暂停新增采集")
	}
	if e != nil {
		return r.syncFailure(ep, id, gen, e)
	}
	now := r.now().UnixMilli()
	v, e := r.commit(ep, id, gen, func(t *storage.Tx, g p.Group) (any, error) {
		identity := r.sourceStatus.O("identity").S("profile")
		if g.S("identity") != "" && g.S("identity") != identity {
			return nil, errors.New("来源身份发生变化，已暂停采集")
		}
		next := g.With(p.Record{"membership": p.Record{"state": "verified", "checkedAt": r.now().UTC().Format(time.RFC3339Nano)}, "identity": identity, "status": "syncing", "lastCheckedAt": now})
		delete(next, "error")
		t.Save("groups", next)
		return next, nil
	})
	if e != nil {
		return e
	}
	g := v.(p.Group)
	r.mu.Lock()
	hasStream := ep.streams[id] != nil
	r.mu.Unlock()
	if !hasStream {
		stop, e := ep.source.Subscribe(ep.ctx, g, func(m p.Message) {
			_, _ = r.commit(ep, id, gen, func(t *storage.Tx, g p.Group) (any, error) {
				if g.O("membership").S("state") != "verified" {
					return nil, nil
				}
				t.Ingest([]p.Message{m}, id, gen)
				g["lastEventAt"] = max(g.N("lastEventAt"), m.N("createdAt"))
				t.Save("groups", g)
				ep.dirty[id] = true
				return nil, nil
			})
		}, func() {
			_, _ = r.commit(ep, id, gen, func(t *storage.Tx, g p.Group) (any, error) {
				g["stream"] = p.Record{"state": "verified", "checkedAt": r.now().UTC().Format(time.RFC3339Nano), "detail": "指定群订阅已就绪；全量接收仍需真实消息验收"}
				t.Save("groups", g)
				return nil, nil
			})
		}, func(err error) {
			_, _ = r.commit(ep, id, gen, func(t *storage.Tx, g p.Group) (any, error) {
				g["stream"] = p.Record{"state": "failed", "detail": err.Error()}
				g["status"] = "partial"
				g["error"] = err.Error()
				t.Save("groups", g)
				delete(ep.streams, id)
				ep.dirty[id] = true
				return nil, nil
			})
		})
		if e != nil {
			return r.syncFailure(ep, id, gen, e)
		}
		r.mu.Lock()
		if r.closed || r.current != ep {
			r.mu.Unlock()
			stop()
			return context.Canceled
		}
		ep.streams[id] = stop
		r.mu.Unlock()
	}
	if e = r.attachPending(ep, ctx, id, gen); e != nil {
		return e
	}
	end := r.now().UnixMilli() / 1000 * 1000
	window := g.O("window")
	if len(window) == 0 {
		window = p.Record{"start": max(g.N("boundAt"), g.N("checkpoint")-120000), "end": end}
	}
	if window.N("start")/1000 >= window.N("end")/1000 {
		_, e = r.commit(ep, id, gen, func(t *storage.Tx, g p.Group) (any, error) {
			g["status"] = "ready"
			t.Save("groups", g)
			return nil, nil
		})
		return e
	}
	_, e = r.commit(ep, id, gen, func(t *storage.Tx, g p.Group) (any, error) {
		g["window"] = window
		t.Save("groups", g)
		return nil, nil
	})
	if e != nil {
		return e
	}
	page, e := ep.source.Read(ctx, g, window.N("start"), window.N("end"), g.S("cursor"))
	if e != nil {
		return r.syncFailure(ep, id, gen, e)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	_, e = r.commit(ep, id, gen, func(t *storage.Tx, g p.Group) (any, error) { t.Ingest(page.Messages, id, gen); return nil, nil })
	if e != nil {
		return e
	}
	if e = r.attachPending(ep, ctx, id, gen); e != nil {
		return e
	}
	_, e = r.commit(ep, id, gen, func(t *storage.Tx, g p.Group) (any, error) {
		if page.Complete {
			g["checkpoint"] = window.N("end")
			delete(g, "window")
			delete(g, "cursor")
			delete(g, "error")
			g["history"] = p.Record{"state": "verified", "checkedAt": r.now().UTC().Format(time.RFC3339Nano), "detail": "该同步窗口已完整补读"}
			g["status"] = "ready"
			r.sourceStatus.O("capabilities")["history"] = g["history"]
		} else {
			if page.Cursor != "" && page.Cursor == g.S("cursor") {
				g["error"] = "分页游标停滞，保留同步窗口"
			} else {
				if page.Cursor != "" {
					g["cursor"] = page.Cursor
				}
				delete(g, "error")
				if page.Error != "" {
					g["error"] = page.Error
				}
			}
			g["status"] = "partial"
			g["history"] = p.Record{"state": "pending", "detail": "补读尚未完成"}
		}
		t.Save("groups", g)
		return nil, nil
	})
	return e
}
func (r *Runtime) syncFailure(ep *epoch, id string, gen int64, cause error) error {
	_, _ = r.commit(ep, id, gen, func(t *storage.Tx, g p.Group) (any, error) {
		g["membership"] = p.Record{"state": "failed", "detail": cause.Error()}
		g["status"] = "paused"
		g["error"] = cause.Error()
		g["lastCheckedAt"] = r.now().UnixMilli()
		t.Save("groups", g)
		return nil, nil
	})
	r.mu.Lock()
	stop := ep.streams[id]
	delete(ep.streams, id)
	r.mu.Unlock()
	if stop != nil {
		stop()
	}
	return cause
}
func (r *Runtime) attachPending(ep *epoch, ctx context.Context, id string, gen int64) error {
	v, e := r.commit(ep, id, gen, func(t *storage.Tx, _ p.Group) (any, error) {
		return t.All("SELECT json FROM messages WHERE group_id=? AND EXISTS(SELECT 1 FROM json_each(messages.json,'$.attachments') WHERE json_extract(value,'$.state')='pending') ORDER BY created,id LIMIT 100", id), nil
	})
	if e != nil {
		return e
	}
	for _, m := range v.([]p.Message) {
		for _, a := range m.Records("attachments") {
			if a.S("state") != "pending" {
				continue
			}
			data, mime, downloadErr := ep.source.Download(ctx, m, a)
			if ctx.Err() != nil {
				return ctx.Err()
			}
			_, e = r.commit(ep, id, gen, func(t *storage.Tx, _ p.Group) (any, error) {
				if downloadErr != nil {
					state := "failed"
					if strings.Contains(downloadErr.Error(), "unsupported") || strings.Contains(downloadErr.Error(), "size_exceeded") {
						state = "unsupported"
					}
					t.UpdateAttachment(a.S("id"), p.Record{"state": state, "error": downloadErr.Error()})
					return nil, nil
				}
				if err := t.SaveAttachment(a.S("id"), data, mime); err != nil {
					t.UpdateAttachment(a.S("id"), p.Record{"state": "failed", "error": err.Error()})
				}
				r.sourceStatus.O("capabilities")["attachments"] = p.Record{"state": "verified", "detail": "已保存核对过身份的附件原件"}
				return nil, nil
			})
			if e != nil {
				return e
			}
		}
	}
	return nil
}
func (r *Runtime) analyze(ep *epoch, ctx context.Context, g p.Group) (any, error) {
	id, gen := g.S("id"), g.N("generation")
	var messages []p.Message
	input := providers.AnalysisInput{Config: r.Config(), Images: []providers.Image{}}
	_, e := r.commit(ep, id, gen, func(t *storage.Tx, _ p.Group) (any, error) {
		messages = t.Pending(id)
		query := ""
		for _, m := range messages {
			query += m.S("text") + " "
		}
		if len(query) > 4000 {
			query = query[:4000]
		}
		input.Requirements = t.Related(query, 20)
		input.Summary = t.MetaText("summary:" + id)
		for _, m := range messages {
			enriched := m.Clone()
			text := m.S("text")
			for _, a := range m.Records("attachments") {
				if a.S("state") != "ready" || a.S("analysisState") == "unsupported" {
					continue
				}
				mime := a.S("mimeType")
				if strings.HasPrefix(mime, "image/") {
					if len(input.Images) >= 4 {
						t.UpdateAttachment(a.S("id"), p.Record{"analysisState": "unsupported", "analysisNote": "本轮图片超过 4 张上限，未参与自动分析；原件仍可查看和投递"})
						continue
					}
					b, e := t.AttachmentBytes(a.S("id"))
					if e != nil {
						return nil, e
					}
					input.Images = append(input.Images, providers.Image{ID: a.S("id"), MimeType: mime, Bytes: b})
				} else if strings.HasPrefix(mime, "text/") || mime == "application/json" || mime == "application/xml" {
					b, e := t.AttachmentBytes(a.S("id"))
					if e != nil {
						return nil, e
					}
					text += "\n附件 " + a.S("name") + "（原始证据）：\n" + string(b)
				}
			}
			enriched["text"] = text
			input.Messages = append(input.Messages, enriched)
		}
		return nil, nil
	})
	if e != nil {
		return nil, e
	}
	result, e := ep.analysis.Analyze(ctx, input)
	if e != nil {
		r.mu.Lock()
		if r.current == ep && ctx.Err() == nil {
			r.analysisAfter = r.now().UnixMilli() + 60000
		}
		r.mu.Unlock()
		return nil, e
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	jobValues := []any{}
	for _, m := range messages {
		jobValues = append(jobValues, []any{m.S("id"), m.S("version")})
	}
	_, e = r.commit(ep, id, gen, func(t *storage.Tx, _ p.Group) (any, error) {
		if t.RecordAnalysis(compat.Hash(jobValues), messages, result.Proposals, gen) {
			t.SetMeta("summary:"+id, result.Summary)
		}
		return nil, nil
	})
	return p.Record{"candidates": len(result.Proposals), "estimatedTokens": result.EstimatedTokens, "tokenCount": "estimate"}, e
}
func (r *Runtime) retire(ep *epoch) {
	ep.cancel()
	ep.source.Close()
	ep.wg.Wait()
	for _, stop := range ep.streams {
		stop()
	}
}
func (r *Runtime) Close() {
	r.cancel()
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	r.cancel()
	ep := r.current
	for _, task := range ep.tasks {
		r.data(context.Background(), func(t *storage.Tx) (any, error) {
			t.SaveTask(task.With(p.Record{"state": "cancelled", "updatedAt": r.now().UnixMilli()}))
			return nil, nil
		})
	}
	r.mu.Unlock()
	r.loop.Wait()
	r.retire(ep)
	_ = r.Store.Close()
}
func (r *Runtime) Handle(ctx context.Context, a p.Action) (any, error) {
	ctx, cancel := context.WithCancel(ctx)
	stop := context.AfterFunc(r.ctx, cancel)
	defer func() { stop(); cancel() }()
	if a.Kind == "snapshot" {
		return r.Snapshot()
	}
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil, errors.New("extension_stopped")
	}
	ep := r.current
	if !r.background && slices.Contains([]string{"connection.check", "auth.start", "models.check", "generation.check", "analysis.retry", "sync.start"}, a.Kind) {
		r.mu.Unlock()
		return nil, errors.New("service_project_paused")
	}
	r.mu.Unlock()
	q := a.Values
	switch a.Kind {
	case "configure":
		cfg, e := p.ParseConfig(q["config"])
		if e != nil {
			return nil, e
		}
		r.mu.Lock()
		v, e := r.data(ctx, func(t *storage.Tx) (any, error) {
			rev, _, e := t.Settings()
			if e != nil {
				return nil, e
			}
			if rev != q.N("revision") {
				return nil, errors.New("settings_revision_conflict")
			}
			if _, ok := q["modelKey"]; ok {
				if e = r.credentials.Set("model-key", q.S("modelKey")); e != nil {
					return nil, e
				}
			}
			if _, ok := q["appSecret"]; ok {
				if e = r.credentials.Set("app-secret", q.S("appSecret")); e != nil {
					return nil, e
				}
			}
			return t.Configure(q.N("revision"), cfg)
		})
		if e != nil {
			r.mu.Unlock()
			return nil, e
		}
		oldCfg := r.Config()
		sourceChanged := string(compat.JSON(oldCfg.Source)) != string(compat.JSON(cfg.Source))
		if _, ok := q["appSecret"]; ok {
			sourceChanged = true
		}
		ep.cancel()
		for _, task := range ep.tasks {
			r.data(context.Background(), func(t *storage.Tx) (any, error) {
				t.SaveTask(task.With(p.Record{"state": "cancelled", "updatedAt": r.now().UnixMilli(), "detail": "配置或扩展状态已改变"}))
				return nil, nil
			})
		}
		r.cfgMu.Lock()
		r.config = cfg
		r.cfgMu.Unlock()
		r.current = r.newEpoch()
		r.sourceStatus = p.EmptySource()
		r.analysisAfter = 0
		r.lastCheck = 0
		if sourceChanged {
			_, e = r.data(ctx, func(t *storage.Tx) (any, error) {
				for _, g := range t.Groups() {
					g["enabled"] = false
					g["generation"] = g.N("generation") + 1
					g["status"] = "paused"
					g["membership"] = p.Pending()
					g["stream"] = p.Pending()
					g["error"] = "来源已改变，请重新绑定"
					t.Save("groups", g)
				}
				return nil, nil
			})
		}
		r.mu.Unlock()
		r.retire(ep)
		r.Tick()
		return v, e
	case "connection.check", "auth.start", "models.check", "generation.check":
		r.mu.Lock()
		defer r.mu.Unlock()
		kind := map[string]string{"connection.check": "connection", "auth.start": "auth", "models.check": "models", "generation.check": "generation"}[a.Kind]
		return r.taskLocked(ep, kind, "", func(c context.Context, update func(p.Record)) (any, error) {
			switch a.Kind {
			case "connection.check":
				return r.checkSource(ep, c)
			case "auth.start":
				update(p.Record{"state": "waiting", "detail": "请在钉钉官方页面确认账号和应用授权"})
				if e := ep.source.Authorize(c, func(url string) { update(p.Record{"authUrl": url}) }); e != nil {
					return nil, e
				}
				return r.checkSource(ep, c)
			case "models.check":
				return ep.analysis.Models(c)
			default:
				return nil, ep.analysis.Check(c)
			}
		}), nil
	case "groups.search":
		return ep.source.SearchGroups(ctx, q.S("query"))
	case "groups.bind", "groups.pause", "groups.remove", "groups.resume", "sync.start":
		id := q.S("groupId")
		r.mu.Lock()
		var stop func()
		v, e := r.data(ctx, func(t *storage.Tx) (any, error) {
			g := t.Get("groups", id)
			switch a.Kind {
			case "groups.bind":
				if g == nil && len(t.Groups()) >= 64 {
					return nil, errors.New("每个项目最多绑定 64 个监控群")
				}
				generation := g.N("generation") + 1
				now := r.now().UnixMilli()
				g = g.With(p.Record{"id": id, "name": q.S("name"), "boundAt": now, "checkpoint": now, "generation": generation, "enabled": true, "membership": p.Pending(), "stream": p.Pending(), "history": p.Pending(), "status": "pending"})
				delete(g, "window")
				delete(g, "cursor")
				delete(g, "lastCheckedAt")
				delete(g, "error")
				if identity := r.sourceStatus.O("identity").S("profile"); identity != "" {
					g["identity"] = identity
				}
			case "groups.resume":
				if g == nil {
					return nil, errors.New("group_missing")
				}
				if g.S("identity") != "" && g.S("identity") != r.sourceStatus.O("identity").S("profile") {
					return nil, errors.New("来源身份已改变，请重新绑定")
				}
				g["enabled"] = true
				g["generation"] = g.N("generation") + 1
				g["status"] = "pending"
				delete(g, "lastCheckedAt")
				delete(g, "error")
			case "sync.start":
				if !g.B("enabled") {
					return nil, errors.New("group_paused")
				}
				delete(g, "lastCheckedAt")
			default:
				if g == nil {
					return nil, nil
				}
				g["enabled"] = false
				g["generation"] = g.N("generation") + 1
				g["status"] = "paused"
			}
			t.Save("groups", g)
			return g, nil
		})
		if a.Kind != "sync.start" {
			stop = ep.streams[id]
			delete(ep.streams, id)
			if cancel := ep.groups[id]; cancel != nil {
				cancel()
			}
			delete(ep.dirty, id)
		}
		r.mu.Unlock()
		if stop != nil {
			stop()
		}
		r.Tick()
		if a.Kind == "sync.start" {
			return p.Record{"queued": true}, e
		}
		return v, e
	case "analysis.retry":
		r.mu.Lock()
		r.analysisAfter = 0
		r.mu.Unlock()
		r.Tick()
		return p.Record{"queued": true}, nil
	default:
		return r.data(ctx, func(t *storage.Tx) (any, error) { return t.Handle(a.Kind, q) })
	}
}
func (r *Runtime) Delivery(ctx context.Context, id, action string, receipt p.Record) (any, error) {
	r.opMu.Lock()
	defer r.opMu.Unlock()
	r.mu.Lock()
	closed := r.closed
	r.mu.Unlock()
	if closed {
		return nil, errors.New("extension_stopped")
	}
	return r.data(ctx, func(t *storage.Tx) (any, error) {
		if action == "claim" {
			return t.ClaimDelivery(id)
		}
		if action == "finish" {
			return t.FinishDelivery(id, receipt)
		}
		return nil, fmt.Errorf("service_route_missing")
	})
}
