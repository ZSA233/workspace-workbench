package providers

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/zsa233/workspace-workbench/communications-service/internal/compat"
	p "github.com/zsa233/workspace-workbench/communications-service/internal/protocol"
	"github.com/zsa233/workspace-workbench/communications-service/internal/storage"
)

func payload(r p.Record) p.Record {
	if len(r.O("data")) > 0 {
		return r.O("data")
	}
	if len(r.O("result")) > 0 {
		return r.O("result")
	}
	return r
}
func first(r p.Record, keys ...string) any {
	for _, k := range keys {
		if v, ok := r[k]; ok && v != nil && v != "" {
			return v
		}
	}
	return nil
}
func stringValue(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return string(compat.Stringify(v))
}
func timestamp(v any) (int64, error) {
	text := stringValue(v)
	var n int64
	if _, e := fmt.Sscan(text, &n); e == nil && regexp.MustCompile(`^\d+$`).MatchString(text) {
		if n < 100000000000 {
			n *= 1000
		}
		return n, nil
	}
	if t, e := time.Parse(time.RFC3339Nano, text); e == nil && t.UnixMilli() >= 0 {
		return t.UnixMilli(), nil
	}
	return 0, errors.New("dws_message_time_invalid")
}
func NormalizeMessage(raw p.Record, group, profile string) (p.Message, error) {
	source, ok := first(raw, "message_id", "messageId", "msgId").(string)
	if !ok || source == "" {
		return nil, errors.New("dws_message_id_missing")
	}
	conversation := stringValue(first(raw, "conversation_id", "openConversationId", "conversationId"))
	if conversation != "" && conversation != group {
		return nil, errors.New("dws_message_group_mismatch")
	}
	created, e := timestamp(first(raw, "create_time", "createTime", "createTimeMs", "timestamp"))
	if e != nil {
		return nil, e
	}
	updated := created
	if v := first(raw, "update_time", "updateTime"); v != nil {
		updated, e = timestamp(v)
		if e != nil {
			return nil, e
		}
	}
	id := compat.Hash([]any{profile, group, source})
	media := first(raw, "resourceRefs", "attachments", "resources", "media")
	mediaRecord := p.Record{"items": media}
	if media != nil {
		if _, ok := media.([]any); !ok {
			if _, ok := media.([]p.Record); !ok {
				return nil, errors.New("dws_message_attachments_invalid")
			}
		}
	}
	attachments := []p.Record{}
	versions := []any{}
	for i, a := range mediaRecord.Records("items") {
		ref := first(a, "resourceId", "id", "fileId", "mediaId", "name")
		if ref == nil {
			ref = i
		}
		name := stringValue(first(a, "name", "fileName"))
		if name == "" {
			name = "attachment"
		}
		mime := stringValue(first(a, "mimeType", "contentType"))
		if mime == "" {
			mime = "application/octet-stream"
		}
		sid := first(a, "resourceId", "id", "fileId", "mediaId")
		if sid == nil {
			sid = i
		}
		item := p.Record{"id": compat.Hash([]any{id, ref}), "sourceId": fmt.Sprint(sid), "name": name, "mimeType": mime, "state": "pending"}
		if a.S("type") == "mediaId" || a.S("type") == "fileId" {
			item["resourceType"] = a.S("type")
		}
		if _, ok := a["size"]; ok {
			item["size"] = a["size"]
		}
		attachments = append(attachments, item)
		versions = append(versions, []any{item.S("id"), mime})
	}
	mentions := []string{}
	for _, m := range raw.A("mentions") {
		if obj, ok := m.(map[string]any); ok {
			mentions = append(mentions, p.Record(obj).S("id"))
		} else if obj, ok := m.(p.Record); ok {
			mentions = append(mentions, obj.S("id"))
		} else {
			mentions = append(mentions, stringValue(m))
		}
	}
	sender := raw.O("sender")
	senderID := stringValue(first(raw, "sender_open_dingtalk_id", "senderId"))
	if senderID == "" {
		senderID = sender.S("id")
	}
	name, ok := raw["sender"].(string)
	if !ok {
		name = sender.S("name")
		if name == "" {
			name = stringValue(first(raw, "senderName", "senderNick"))
		}
		if name == "" {
			name = "未知发送者"
		}
	}
	text := stringValue(first(raw, "text", "content"))
	reply := raw.O("quoted_message").S("message_id")
	if reply == "" {
		reply = raw.O("quotedMessage").S("messageId")
	}
	if reply == "" {
		reply = raw.S("replyTo")
	}
	var replyValue any
	if reply != "" {
		replyValue = reply
	}
	m := p.Record{"id": id, "sourceId": source, "groupId": group, "senderId": senderID, "sender": name, "text": text, "createdAt": created, "updatedAt": updated, "mentions": mentions, "attachments": attachments, "raw": raw, "version": compat.Hash([]any{text, senderID, replyValue, mentions, versions, updated})}
	if reply != "" {
		m["replyTo"] = reply
	}
	return m, nil
}
func DecodePage(raw p.Record, group, profile string) (SourcePage, error) {
	r := payload(raw)
	if _, ok := r["messages"].([]any); !ok {
		return SourcePage{}, errors.New("dws_messages_contract_invalid")
	}
	if len(r.Records("messages")) != len(r.A("messages")) {
		return SourcePage{}, errors.New("dws_messages_contract_invalid")
	}
	page := SourcePage{Messages: []p.Message{}, Complete: r.B("complete") && r["hasMore"] == false && len(r.A("failures")) == 0 && !r.B("truncated") && !r.B("truncatedByResultLimit"), Cursor: r.S("nextPageToken")}
	for _, raw := range r.Records("messages") {
		m, e := NormalizeMessage(raw, group, profile)
		if e != nil {
			return page, e
		}
		page.Messages = append(page.Messages, m)
	}
	if !page.Complete && page.Cursor == "" {
		page.Error = "消息读取未完成，保留已保存消息与同步窗口；请检查 DWS 分页或权限状态"
	}
	return page, nil
}

type DWS struct {
	Root     string
	Config   func() p.Config
	Secret   func() (string, error)
	Limits   *Limits
	mu       sync.Mutex
	profile  string
	closed   bool
	children map[*exec.Cmd]context.CancelFunc
	wg       sync.WaitGroup
}

func NewDWS(root string, c func() p.Config, secret func() (string, error), limits *Limits) *DWS {
	return &DWS{Root: root, Config: c, Secret: secret, Limits: limits, children: map[*exec.Cmd]context.CancelFunc{}}
}
func (d *DWS) Profile() string {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.profile != "" {
		return d.profile
	}
	return d.Config().Source.Profile
}
func (d *DWS) authRoot(c p.SourceConfig) string {
	app := c.ClientID
	if c.Mode != "custom" {
		app = "default"
	}
	return filepath.Join(d.Root, "auth", compat.Hash([]any{c.Mode, app})[:24])
}
func (d *DWS) command(ctx context.Context, args []string, cwd string, credentials bool) (*exec.Cmd, context.CancelFunc, error) {
	c := d.Config().Source
	if c.Executable != "dws" && !filepath.IsAbs(c.Executable) {
		return nil, nil, errors.New("DWS 程序路径必须是绝对路径，或使用 PATH 中的 dws")
	}
	if cwd == "" {
		cwd = d.Root
	}
	if e := storage.Directory(cwd); e != nil {
		return nil, nil, e
	}
	env := []string{}
	for _, v := range os.Environ() {
		k := strings.SplitN(v, "=", 2)[0]
		if k != "DWS_CONFIG_DIR" && k != "DWS_CLIENT_ID" && k != "DWS_CLIENT_SECRET" && k != "DINGTALK_DWS_AGENTCODE" {
			env = append(env, v)
		}
	}
	env = append(env, "DWS_CONFIG_DIR="+d.authRoot(c), "DINGTALK_DWS_AGENTCODE=workspace-workbench")
	if credentials && c.Mode == "custom" {
		secret, e := d.Secret()
		if e != nil {
			return nil, nil, e
		}
		if c.ClientID == "" || secret == "" {
			return nil, nil, errors.New("请先配置自建应用 Client ID 和 App Secret")
		}
		env = append(env, "DWS_CLIENT_ID="+c.ClientID, "DWS_CLIENT_SECRET="+secret)
	}
	if credentials && c.Profile != "" {
		args = append(args, "--profile", c.Profile)
	}
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, c.Executable, args...)
	cmd.Dir = cwd
	cmd.Env = env
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.WaitDelay = 4 * time.Second
	done := make(chan struct{})
	cmd.Cancel = func() error {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			go func() {
				select {
				case <-time.After(3 * time.Second):
					_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
				case <-done:
				}
			}()
		}
		return nil
	}
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		cancel()
		return nil, nil, errors.New("operation_cancelled")
	}
	d.children[cmd] = cancel
	d.wg.Add(1)
	d.mu.Unlock()
	finish := func() {
		cancel()
		close(done)
		d.mu.Lock()
		delete(d.children, cmd)
		d.mu.Unlock()
		d.wg.Done()
	}
	return cmd, finish, nil
}

type limitedBuffer struct {
	bytes.Buffer
	max      int
	overflow bool
	cancel   context.CancelFunc
}

func (b *limitedBuffer) Write(data []byte) (int, error) {
	if b.Len()+len(data) > b.max {
		b.overflow = true
		if b.cancel != nil {
			b.cancel()
		}
		return 0, errors.New("dws_output_exceeded")
	}
	return b.Buffer.Write(data)
}
func (d *DWS) run(ctx context.Context, args []string, cwd string, partial bool) (p.Record, error) {
	release, e := Acquire(ctx, d.Limits.DWS)
	if e != nil {
		return nil, e
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd, finish, e := d.command(ctx, append(args, "--format", "json"), cwd, true)
	if e != nil {
		return nil, e
	}
	defer finish()
	out := &limitedBuffer{max: 8 * 1024 * 1024, cancel: cancel}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	e = cmd.Run()
	if out.overflow {
		return nil, errors.New("dws_output_exceeded")
	}
	if ctx.Err() != nil {
		return nil, errors.New("DWS 请求超时或已取消")
	}
	if e != nil && errors.Is(e, exec.ErrNotFound) {
		return nil, errors.New("DWS 未安装或路径不可用")
	}
	r, parseErr := decodeDWSJSON(out.Bytes())
	if parseErr != nil {
		return nil, errors.New("DWS 响应格式无效，请检查版本与授权")
	}
	auth := len(args) > 1 && args[0] == "auth" && args[1] == "status"
	if e != nil && !(partial && payload(r)["messages"] != nil) && !(auth && r["authenticated"] != nil) {
		return nil, errors.New("DWS 操作未完成，请核对应用、组织授权与账号")
	}
	if r["success"] == false && !partial && !auth {
		return nil, errors.New("DWS 未授权或接口权限不足")
	}
	return r, nil
}
func (d *DWS) Check(ctx context.Context) (p.Record, error) {
	r := p.EmptySource()
	versionCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	release, e := Acquire(ctx, d.Limits.DWS)
	if e != nil {
		return r, e
	}
	cmd, finish, e := d.command(versionCtx, []string{"version"}, "", false)
	if e != nil {
		release()
		r["detail"] = e.Error()
		return r, nil
	}
	out := &limitedBuffer{max: 16384, cancel: cancel}
	cmd.Stdout = out
	cmd.Stderr = io.Discard
	e = cmd.Run()
	finish()
	release()
	if e != nil || out.overflow {
		r["detail"] = "DWS 版本检测失败"
		if errors.Is(e, exec.ErrNotFound) || errors.Is(e, os.ErrNotExist) {
			r["detail"] = "DWS 未安装或路径不可用"
		}
		return r, nil
	}
	r["installed"] = true
	version := regexp.MustCompile(`1\.\d+\.\d+\b`).FindString(out.String())
	r["version"] = version
	if version != "1.0.68" {
		r["state"] = "failed"
		r["detail"] = "首期适配 DWS 1.0.68；请使用该版本并重新检测"
		return r, nil
	}
	auth, e := d.run(ctx, []string{"auth", "status", "--readonly"}, "", false)
	if e != nil {
		r["state"] = "failed"
		r["detail"] = e.Error()
		return r, nil
	}
	if !auth.B("authenticated") || auth.S("corp_id") == "" || auth.S("user_id") == "" {
		r["state"] = "unauthorized"
		r["detail"] = "待授权：连接使用当前应用和账号，不会自动申请组织权限"
		return r, nil
	}
	if auth.S("reason") != "" {
		r["state"] = "failed"
		r["detail"] = "DWS 登录状态待修复，请在同一授权配置下重新登录"
		return r, nil
	}
	profile := auth.S("corp_id") + ":" + auth.S("user_id")
	d.mu.Lock()
	d.profile = profile
	d.mu.Unlock()
	identity := p.Record{"profile": profile, "corpId": auth.S("corp_id"), "userId": auth.S("user_id")}
	if d.Config().Source.Mode == "custom" {
		identity["clientId"] = d.Config().Source.ClientID
	}
	r["identity"] = identity
	r["state"] = "ready"
	r["authenticated"] = true
	r["detail"] = "账号已授权；请绑定已加入机器人的项目群，分别验证订阅、补读与附件能力"
	return r, nil
}
func (d *DWS) SearchGroups(ctx context.Context, query string) ([]p.Record, error) {
	r, e := d.run(ctx, []string{"chat", "+chat-search", "--query", query, "--page-all"}, "", false)
	if e != nil {
		return nil, e
	}
	r = payload(r)
	items := r.Records("groups")
	if r["groups"] == nil {
		items = r.Records("items")
	}
	if (r["groups"] == nil && r["items"] == nil) || r["complete"] == false || r.B("hasMore") {
		return nil, errors.New("群搜索结果不完整，无法安全绑定")
	}
	out := []p.Record{}
	for _, item := range items {
		if item.S("openConversationId") == "" {
			return nil, errors.New("群搜索缺少稳定 ID")
		}
		name := stringValue(first(item, "name", "title", "openConversationId"))
		out = append(out, p.Record{"id": item.S("openConversationId"), "name": name})
	}
	return out, nil
}
func (d *DWS) VerifyMembership(ctx context.Context, g p.Group) (bool, error) {
	bot := d.Config().Source.BotID
	if bot == "" {
		return false, errors.New("请配置机器人 OpenBotId 或 robotCode，以核对入群状态")
	}
	r, e := d.run(ctx, []string{"chat", "+chat-bots", "--group", g.S("id")}, "", false)
	if e != nil {
		return false, e
	}
	r = payload(r)
	if r["bots"] == nil || r["complete"] == false || r.B("hasMore") || len(r.A("failures")) > 0 {
		return false, errors.New("机器人入群状态无法确认，暂停新增采集")
	}
	for _, b := range r.Records("bots") {
		if b.S("openBotId") == bot || b.S("robotCode") == bot || b.S("botId") == bot {
			return true, nil
		}
	}
	return false, nil
}
func (d *DWS) Read(ctx context.Context, g p.Group, start, end int64, cursor string) (SourcePage, error) {
	format := func(n int64) string { return time.Unix(n/1000, 0).UTC().Format("2006-01-02T15:04:05.000Z") }
	args := []string{"chat", "+chat-messages", "--group", g.S("id"), "--start", format(start), "--end", format(end), "--order", "asc", "--page-all", "--page-limit", "1", "--limit", "100"}
	if cursor != "" {
		args = append(args, "--page-token", cursor)
	}
	r, e := d.run(ctx, args, "", true)
	if e != nil {
		return SourcePage{}, e
	}
	return DecodePage(r, g.S("id"), d.Profile())
}
func (d *DWS) Subscribe(ctx context.Context, g p.Group, receive func(p.Message), ready func(), failed func(error)) (func(), error) {
	ctx, cancel := context.WithCancel(ctx)
	cmd, finish, e := d.command(ctx, []string{"event", "+listen-im", "--kind", "group", "--chat-id", g.S("id"), "--flatten", "-f", "ndjson"}, "", true)
	if e != nil {
		cancel()
		return nil, e
	}
	out, e := cmd.StdoutPipe()
	if e != nil {
		finish()
		cancel()
		return nil, e
	}
	stderr, e := cmd.StderrPipe()
	if e != nil {
		finish()
		cancel()
		return nil, e
	}
	if e = cmd.Start(); e != nil {
		finish()
		cancel()
		return nil, e
	}
	done := make(chan struct{})
	var readers sync.WaitGroup
	var once sync.Once
	var readyOnce sync.Once
	readySignal := make(chan struct{})
	fail := func(e error) {
		once.Do(func() {
			if ctx.Err() == nil {
				failed(e)
			}
			cancel()
		})
	}
	readers.Add(2)
	go func() {
		defer readers.Done()
		scanner := bufio.NewScanner(stderr)
		scanner.Buffer(make([]byte, 4096), 8192)
		for scanner.Scan() {
			if strings.Contains(scanner.Text(), "[event] ready") {
				readyOnce.Do(func() { ready(); close(readySignal) })
			}
		}
	}()
	go func() {
		defer readers.Done()
		scanner := bufio.NewScanner(out)
		scanner.Buffer(make([]byte, 4096), 2*1024*1024)
		for scanner.Scan() {
			if ctx.Err() != nil {
				return
			}
			raw, e := decodeDWSJSON(scanner.Bytes())
			if e != nil {
				fail(errors.New("DWS 事件格式不符合适配版本，保留同步断点"))
				return
			}
			if raw.S("message_id") == "" || raw.S("conversation_id") == "" {
				continue
			}
			select {
			case <-readySignal:
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
				fail(errors.New("DWS 在就绪前返回业务事件"))
				return
			}
			m, e := NormalizeMessage(raw, g.S("id"), d.Profile())
			if e != nil {
				fail(e)
				return
			}
			receive(m)
		}
		if e := scanner.Err(); e != nil {
			fail(errors.New("DWS 事件超出大小限制或读取失败"))
		}
	}()
	go func() {
		select {
		case <-readySignal:
		case <-ctx.Done():
		case <-time.After(30 * time.Second):
			fail(errors.New("DWS 订阅就绪超时"))
		}
	}()
	go func() {
		readers.Wait()
		_ = cmd.Wait()
		if ctx.Err() == nil {
			fail(errors.New("DWS 连接已中断，将在重连时补读遗漏消息"))
		}
		finish()
		close(done)
	}()
	return func() { cancel(); <-done }, nil
}

type loginOutput struct {
	mu     sync.Mutex
	buffer []byte
	seen   map[string]bool
	update func(string)
}

func (w *loginOutput) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.buffer = append(w.buffer, data...)
	if len(w.buffer) > 32768 {
		w.buffer = w.buffer[len(w.buffer)-32768:]
	}
	pattern := regexp.MustCompile(`https://[^\s<>"'\x1b]+`)
	for _, u := range pattern.FindAllString(string(w.buffer), -1) {
		if (strings.HasPrefix(u, "https://login.dingtalk.com/") || strings.HasPrefix(u, "https://oa.dingtalk.com/")) && !w.seen[u] {
			w.seen[u] = true
			w.update(u)
		}
	}
	return len(data), nil
}
func (d *DWS) Authorize(ctx context.Context, update func(string)) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	release, e := Acquire(ctx, d.Limits.DWS)
	if e != nil {
		return e
	}
	defer release()
	cmd, finish, e := d.command(ctx, []string{"auth", "login", "--device", "--format", "json"}, "", true)
	if e != nil {
		return e
	}
	defer finish()
	output := &loginOutput{seen: map[string]bool{}, update: update}
	cmd.Stdout = output
	cmd.Stderr = output
	if e = cmd.Run(); e != nil {
		return errors.New("授权未完成；请检查组织和当前应用的可用范围")
	}
	return nil
}

func (d *DWS) Download(ctx context.Context, m p.Message, a p.Record) ([]byte, string, error) {
	if a.N("size") > 8*1024*1024 {
		return nil, "", errors.New("attachment_size_exceeded")
	}
	if a.S("resourceType") != "mediaId" && a.S("resourceType") != "fileId" {
		return nil, "", errors.New("unsupported_resource_metadata")
	}
	temp, e := os.MkdirTemp(d.Root, "download-")
	if e != nil {
		return nil, "", e
	}
	defer os.RemoveAll(temp)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	watchDone := make(chan struct{})
	go func() {
		defer close(watchDone)
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				entries, e := os.ReadDir(temp)
				if e != nil {
					continue
				}
				var size int64
				for _, item := range entries {
					info, e := item.Info()
					if e != nil {
						continue
					}
					if !info.Mode().IsRegular() {
						cancel()
						return
					}
					size += info.Size()
				}
				if size > 8*1024*1024 {
					cancel()
					return
				}
			}
		}
	}()
	defer func() { cancel(); <-watchDone }()
	r, e := d.run(ctx, []string{"chat", "+messages-resource-download", "--type", a.S("resourceType"), "--resource-id", a.S("sourceId"), "--message-id", m.S("sourceId"), "--open-conversation-id", m.S("groupId"), "--output", "payload.bin"}, temp, false)
	if e != nil {
		return nil, "", e
	}
	r = payload(r)
	if r.S("resourceId") != a.S("sourceId") || r.S("messageId") != m.S("sourceId") || r.S("localPath") != "payload.bin" {
		return nil, "", errors.New("attachment_download_identity_mismatch")
	}
	b, e := storage.ReadFile(filepath.Join(temp, "payload.bin"), 8*1024*1024)
	mime := a.S("mimeType")
	if mime == "application/octet-stream" {
		if v := map[string]string{".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".csv": "text/csv", ".xml": "application/xml", ".log": "text/plain", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".pdf": "application/pdf"}[strings.ToLower(filepath.Ext(a.S("name")))]; v != "" {
			mime = v
		}
	}
	return b, mime, e
}
func (d *DWS) Close() {
	d.mu.Lock()
	d.closed = true
	for _, cancel := range d.children {
		cancel()
	}
	d.mu.Unlock()
	d.wg.Wait()
}

func decodeDWSJSON(data []byte) (p.Record, error) {
	ordered, e := compat.ParseOrdered(data)
	if e != nil {
		return nil, e
	}
	var plain func(any) any
	plain = func(v any) any {
		switch x := v.(type) {
		case compat.Ordered:
			out := p.Record{}
			for _, f := range x {
				if f.Key == "content" || f.Key == "text" {
					if _, ok := f.Value.(compat.Ordered); ok {
						out[f.Key] = f.Value
						continue
					}
				}
				out[f.Key] = plain(f.Value)
			}
			return out
		case []any:
			out := make([]any, len(x))
			for i, v := range x {
				out[i] = plain(v)
			}
			return out
		}
		return v
	}
	r, ok := plain(ordered).(p.Record)
	if !ok {
		return nil, errors.New("dws_response_invalid")
	}
	return r, nil
}
