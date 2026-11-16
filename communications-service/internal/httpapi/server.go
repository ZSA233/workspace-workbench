package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/zsa233/workspace-workbench/communications-service/internal/compat"
	p "github.com/zsa233/workspace-workbench/communications-service/internal/protocol"
	"github.com/zsa233/workspace-workbench/communications-service/internal/providers"
	"github.com/zsa233/workspace-workbench/communications-service/internal/runtime"
	"github.com/zsa233/workspace-workbench/communications-service/internal/storage"
)

var Version = "0.2.0"
var Commit = "development"
var BuildTime = "unknown"
var projectID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)
var tokenPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type Options struct {
	Home, Address  string
	RuntimeFactory func(runtime.Options) (*runtime.Runtime, error)
}
type project struct {
	mu      sync.Mutex
	record  p.Record
	runtime *runtime.Runtime
}
type Server struct {
	Home, URL, Token, InstanceID string
	http                         *http.Server
	listener                     net.Listener
	mu                           sync.Mutex
	projects                     map[string]*project
	registry                     p.Record
	limits                       *providers.Limits
	factory                      func(runtime.Options) (*runtime.Runtime, error)
	release                      func()
	draining                     atomic.Bool
	once                         sync.Once
	done                         chan struct{}
	gate                         sync.Mutex
	requests                     sync.WaitGroup
	slots                        chan struct{}
}

func ServiceToken(home string) (string, error) {
	if e := storage.Directory(home); e != nil {
		return "", e
	}
	path := filepath.Join(home, "api-token")
	f, e := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e == nil {
		_, e = f.WriteString(hex.EncodeToString(storage.Random(32)))
		ce := f.Close()
		if e == nil {
			e = ce
		}
	}
	if e != nil && !os.IsExist(e) {
		return "", e
	}
	b, e := storage.ReadFile(path, 1024)
	if e != nil {
		return "", e
	}
	stat, e := os.Stat(path)
	if e != nil {
		return "", e
	}
	if stat.Mode().Perm()&0077 != 0 {
		return "", errors.New("service_token_permissions_invalid")
	}
	token := strings.TrimSpace(string(b))
	if !tokenPattern.MatchString(token) {
		return "", errors.New("service_token_invalid")
	}
	return token, nil
}
func Start(o Options) (*Server, error) {
	release, e := storage.AcquireLease(o.Home)
	if e != nil {
		return nil, e
	}
	token, e := ServiceToken(o.Home)
	if e != nil {
		release()
		return nil, e
	}
	s := &Server{Home: o.Home, Token: token, InstanceID: storage.ID(), release: release, projects: map[string]*project{}, registry: p.Record{"version": 1, "projects": []p.Record{}}, limits: providers.NewLimits(), factory: o.RuntimeFactory, done: make(chan struct{}), slots: make(chan struct{}, 64)}
	if s.factory == nil {
		s.factory = runtime.New
	}
	if b, e := storage.ReadFile(filepath.Join(o.Home, "projects.json"), 1024*1024); e == nil {
		s.registry, e = p.Decode(b)
		if e != nil || s.registry.N("version") != 1 || s.registry["projects"] == nil {
			release()
			return nil, errors.New("service_registry_invalid")
		}
		for _, record := range s.registry.Records("projects") {
			if !projectID.MatchString(record.S("id")) || p.Length(record.S("name")) > 500 {
				release()
				return nil, errors.New("service_registry_invalid")
			}
			if _, ok := record["active"].(bool); !ok {
				release()
				return nil, errors.New("service_registry_invalid")
			}
			if s.projects[record.S("id")] != nil {
				release()
				return nil, errors.New("service_registry_invalid")
			}
			s.projects[record.S("id")] = &project{record: record}
		}
	} else if !os.IsNotExist(e) {
		release()
		return nil, e
	}
	address := o.Address
	if address == "" {
		address = "127.0.0.1:47191"
	}
	s.listener, e = net.Listen("tcp", address)
	if e != nil {
		release()
		return nil, e
	}
	s.URL = "http://" + s.listener.Addr().String()
	s.http = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 64 * 1024}
	go func() { _ = s.http.Serve(s.listener) }()
	s.mu.Lock()
	activeIDs := []string{}
	for id, project := range s.projects {
		if project.record.B("active") {
			activeIDs = append(activeIDs, id)
		}
	}
	s.mu.Unlock()
	for _, id := range activeIDs {
		_, _ = s.getRuntime(id)
	}
	return s, nil
}
func (s *Server) Done() <-chan struct{} { return s.done }
func (s *Server) saveLocked() error {
	items := []p.Record{}
	for _, item := range s.registry.Records("projects") {
		if v := s.projects[item.S("id")]; v != nil {
			items = append(items, v.record.Clone())
		}
	}
	known := map[string]bool{}
	for _, r := range items {
		known[r.S("id")] = true
	}
	for id, v := range s.projects {
		if !known[id] {
			items = append(items, v.record.Clone())
		}
	}
	s.registry["projects"] = items
	return storage.Atomic(filepath.Join(s.Home, "projects.json"), compat.JSON(s.registry))
}
func (s *Server) getRuntime(id string) (*runtime.Runtime, error) {
	s.mu.Lock()
	slot := s.projects[id]
	s.mu.Unlock()
	if slot == nil {
		return nil, errors.New("service_project_missing")
	}
	slot.mu.Lock()
	defer slot.mu.Unlock()
	if slot.runtime != nil {
		return slot.runtime, nil
	}
	if s.draining.Load() {
		return nil, errors.New("service_draining")
	}
	s.mu.Lock()
	active := slot.record.B("active")
	s.mu.Unlock()
	r, e := s.factory(runtime.Options{Root: filepath.Join(s.Home, "projects", id), Credentials: &storage.Credentials{Root: filepath.Join(s.Home, "secrets", id)}, Background: active, Limits: s.limits})
	if e != nil {
		return nil, e
	}
	slot.runtime = r
	if s.draining.Load() {
		r.Close()
		return nil, errors.New("service_draining")
	}
	r.Start()
	return r, nil
}
func reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func body(w http.ResponseWriter, r *http.Request) (p.Record, error) {
	b, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 1024*1024))
	if e != nil {
		return nil, errors.New("request_size_exceeded")
	}
	if len(b) == 0 {
		return p.Record{}, nil
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.UseNumber()
	var out p.Record
	if e = d.Decode(&out); e != nil || out == nil {
		return nil, errors.New("invalid_request")
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return nil, errors.New("invalid_request")
	}
	return out, nil
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Origin") != "" {
		reply(w, 403, p.Record{"error": "browser_origin_not_allowed"})
		return
	}
	supplied := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(supplied), []byte(s.Token)) != 1 {
		reply(w, 401, p.Record{"error": "service_unauthorized"})
		return
	}
	if r.Method == "GET" && r.URL.Path == "/health" {
		s.mu.Lock()
		count := len(s.projects)
		s.mu.Unlock()
		state := "running"
		if s.draining.Load() {
			state = "draining"
		}
		reply(w, 200, p.Record{"product": "project-communications-service", "apiVersion": 1, "version": Version, "instanceId": s.InstanceID, "projects": count, "state": state})
		return
	}
	s.gate.Lock()
	if s.draining.Load() {
		s.gate.Unlock()
		reply(w, 503, p.Record{"error": "service_draining"})
		return
	}
	s.requests.Add(1)
	s.gate.Unlock()
	defer s.requests.Done()
	select {
	case s.slots <- struct{}{}:
		defer func() { <-s.slots }()
	default:
		reply(w, 503, p.Record{"error": "service_busy"})
		return
	}
	v, status, e := s.handle(w, r)
	if e != nil {
		reply(w, status, p.Record{"error": e.Error()})
		return
	}
	reply(w, status, v)
}
func (s *Server) handle(w http.ResponseWriter, r *http.Request) (any, int, error) {
	path := r.URL.Path
	if r.Method == "GET" && path == "/v1/projects" {
		s.mu.Lock()
		items := []p.Record{}
		for _, item := range s.registry.Records("projects") {
			items = append(items, item.Clone())
		}
		s.mu.Unlock()
		return p.Record{"projects": items}, 200, nil
	}
	if r.Method == "POST" && path == "/v1/shutdown" {
		go s.Close()
		return p.Record{"state": "draining"}, 202, nil
	}
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if len(parts) < 3 || parts[0] != "v1" || parts[1] != "projects" || !projectID.MatchString(parts[2]) {
		return nil, 404, errors.New("service_route_missing")
	}
	id := parts[2]
	if len(parts) == 3 && r.Method == "PUT" {
		input, e := body(w, r)
		if e != nil {
			return nil, 400, e
		}
		if p.Length(input.S("name")) < 1 || p.Length(input.S("name")) > 500 {
			return nil, 400, errors.New("invalid_request")
		}
		s.mu.Lock()
		defer s.mu.Unlock()
		slot := s.projects[id]
		if slot == nil {
			slot = &project{record: p.Record{"id": id, "name": input.S("name"), "active": true}}
			s.projects[id] = slot
			if e = s.saveLocked(); e != nil {
				delete(s.projects, id)
				return nil, 400, e
			}
		}
		return p.Record{"project": slot.record.Clone()}, 200, nil
	}
	s.mu.Lock()
	slot := s.projects[id]
	s.mu.Unlock()
	if slot == nil {
		return nil, 404, errors.New("service_project_missing")
	}
	if r.Method != "POST" {
		return nil, 405, errors.New("service_method_not_allowed")
	}
	if len(parts) == 4 && parts[3] == "control" {
		input, e := body(w, r)
		if e != nil {
			return nil, 400, e
		}
		active, ok := input["active"].(bool)
		if !ok {
			return nil, 400, errors.New("invalid_request")
		}
		slot.mu.Lock()
		s.mu.Lock()
		previous := slot.record
		slot.record = slot.record.With(p.Record{"active": active})
		e = s.saveLocked()
		if e != nil {
			slot.record = previous
		}
		record := slot.record.Clone()
		s.mu.Unlock()
		if e != nil {
			slot.mu.Unlock()
			return nil, 400, e
		}
		old := slot.runtime
		slot.runtime = nil
		if old != nil {
			old.Close()
		}
		slot.mu.Unlock()
		if active && !s.draining.Load() {
			if _, e = s.getRuntime(id); e != nil {
				return nil, 400, e
			}
		}
		return p.Record{"project": record}, 200, nil
	}
	runtime, e := s.getRuntime(id)
	if e != nil {
		return nil, 400, e
	}
	if len(parts) == 4 && parts[3] == "actions" {
		input, e := body(w, r)
		if e != nil {
			return nil, 400, e
		}
		a, e := p.ParseAction(input)
		if e != nil {
			return nil, 400, e
		}
		result, e := runtime.Handle(r.Context(), a)
		return p.Record{"result": result}, statusFor(e), e
	}
	if len(parts) == 6 && parts[3] == "deliveries" && p.Length(parts[4]) <= 512 && (parts[5] == "claim" || parts[5] == "finish") {
		input, e := body(w, r)
		if e != nil {
			return nil, 400, e
		}
		if parts[5] == "finish" {
			if input.S("delivery") != "accepted" && input.S("delivery") != "uncertain" || p.Length(input.S("messageId")) > 500 {
				return nil, 400, errors.New("invalid_request")
			}
		}
		result, e := runtime.Delivery(r.Context(), parts[4], parts[5], input)
		return p.Record{"result": result}, statusFor(e), e
	}
	return nil, 404, errors.New("service_route_missing")
}
func (s *Server) Close() {
	s.once.Do(func() {
		s.gate.Lock()
		s.draining.Store(true)
		s.gate.Unlock()
		s.mu.Lock()
		slots := make([]*project, 0, len(s.projects))
		for _, slot := range s.projects {
			slots = append(slots, slot)
		}
		s.mu.Unlock()
		var wg sync.WaitGroup
		for _, slot := range slots {
			wg.Add(1)
			go func() {
				defer wg.Done()
				slot.mu.Lock()
				defer slot.mu.Unlock()
				if slot.runtime != nil {
					slot.runtime.Close()
				}
			}()
		}
		wg.Wait()
		s.requests.Wait()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := s.http.Shutdown(ctx); e != nil {
			_ = s.http.Close()
		}
		s.release()
		close(s.done)
	})
}

func statusFor(e error) int {
	if e != nil {
		return 400
	}
	return 200
}
