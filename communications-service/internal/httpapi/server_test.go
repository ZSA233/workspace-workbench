package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	p "github.com/zsa233/workspace-workbench/communications-service/internal/protocol"
	"github.com/zsa233/workspace-workbench/communications-service/internal/providers"
	"github.com/zsa233/workspace-workbench/communications-service/internal/runtime"
	"github.com/zsa233/workspace-workbench/communications-service/internal/storage"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func start(t *testing.T, home string) *Server {
	t.Helper()
	s, e := Start(Options{Home: home, Address: "127.0.0.1:0"})
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(s.Close)
	return s
}
func call(t *testing.T, s *Server, path, method string, input any) (int, p.Record) {
	t.Helper()
	var b io.Reader
	if input != nil {
		data, e := json.Marshal(input)
		if e != nil {
			t.Fatal(e)
		}
		b = bytes.NewReader(data)
	}
	req, e := http.NewRequest(method, s.URL+path, b)
	if e != nil {
		t.Fatal(e)
	}
	req.Header.Set("Authorization", "Bearer "+s.Token)
	res, e := http.DefaultClient.Do(req)
	if e != nil {
		t.Fatal(e)
	}
	defer res.Body.Close()
	data, e := io.ReadAll(res.Body)
	if e != nil {
		t.Fatal(e)
	}
	r, e := p.Decode(data)
	if e != nil {
		t.Fatal(e, string(data))
	}
	return res.StatusCode, r
}
func TestAuthenticatedAPIProjectIsolationAndSettings(t *testing.T) {
	s := start(t, t.TempDir())
	response, e := http.Get(s.URL + "/health")
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 401 {
		t.Fatal(response.StatusCode)
	}
	status, r := call(t, s, "/health", "GET", nil)
	if status != 200 || r.N("apiVersion") != 1 || r.S("version") != "0.2.0" {
		t.Fatal(r)
	}
	for _, id := range []string{"one", "two"} {
		status, _ = call(t, s, "/v1/projects/"+id, "PUT", p.Record{"name": id})
		if status != 200 {
			t.Fatal(status)
		}
	}
	snapshot := func(id string) p.Record {
		status, r := call(t, s, "/v1/projects/"+id+"/actions", "POST", p.Record{"action": "snapshot"})
		if status != 200 {
			t.Fatal(r)
		}
		return r.O("result")
	}
	one := snapshot("one")
	cfg := one.O("config")
	cfg.O("model")["contextTokens"] = 524288
	status, r = call(t, s, "/v1/projects/one/actions", "POST", p.Record{"action": "configure", "revision": one.N("revision"), "config": cfg, "modelKey": "fixture-secret"})
	if status != 200 {
		t.Fatal(r)
	}
	if snapshot("two").O("config").O("model").N("contextTokens") != 131072 {
		t.Fatal("project leak")
	}
	b, _ := json.Marshal(snapshot("one"))
	if strings.Contains(string(b), "fixture-secret") {
		t.Fatal("secret in API")
	}
	status, r = call(t, s, "/v1/projects/one/actions", "POST", p.Record{"action": "configure", "revision": one.N("revision"), "config": cfg})
	if status != 400 || r.S("error") != "settings_revision_conflict" {
		t.Fatal(status, r)
	}
	request, _ := http.NewRequest("GET", s.URL+"/health", nil)
	request.Header.Set("Authorization", "Bearer "+s.Token)
	request.Header.Set("Origin", "https://example.com")
	res, e := http.DefaultClient.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	res.Body.Close()
	if res.StatusCode != 403 {
		t.Fatal(res.StatusCode)
	}
	for _, path := range []string{"/v1/projects/..%2Foutside/actions", "/v1/projects/invalid!", "/arbitrary"} {
		status, _ := call(t, s, path, "POST", p.Record{})
		if status != 404 {
			t.Fatal(path, status)
		}
	}
}
func TestRestartIndependentOfWorkbenchAndRetainsRegistryUnknownFields(t *testing.T) {
	home := t.TempDir()
	data := `{"version":1,"unknown":"retain","projects":[{"id":"one","name":"项目","active":false,"unknown":"retain-project"}]}`
	if e := os.WriteFile(filepath.Join(home, "projects.json"), []byte(data), 0600); e != nil {
		t.Fatal(e)
	}
	s := start(t, home)
	status, r := call(t, s, "/v1/projects/one/actions", "POST", p.Record{"action": "snapshot"})
	if status != 200 || r.O("result").S("background") != "paused" {
		t.Fatal(r)
	}
	status, r = call(t, s, "/v1/projects/one/control", "POST", p.Record{"active": true})
	if status != 200 {
		t.Fatal(r)
	}
	s.Close()
	s2 := start(t, home)
	_, r = call(t, s2, "/v1/projects/one/actions", "POST", p.Record{"action": "snapshot"})
	if r.O("result").S("background") != "running" {
		t.Fatal(r)
	}
	b, _ := os.ReadFile(filepath.Join(home, "projects.json"))
	parsed, _ := p.Decode(b)
	if parsed.S("unknown") != "retain" || parsed.Records("projects")[0].S("unknown") != "retain-project" {
		t.Fatal(string(b))
	}
	status, _ = call(t, s2, "/v1/shutdown", "POST", nil)
	if status != 202 {
		t.Fatal(status)
	}
	select {
	case <-s2.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("shutdown timed out")
	}
}
func TestSQLiteLeaseInteroperatesWithNodeBothWays(t *testing.T) {
	node, e := exec.LookPath("node")
	if e != nil {
		t.Skip("optional old Node lease interoperability requires Node")
	}
	home := t.TempDir()
	release, e := storage.AcquireLease(home)
	if e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(home, ".backend-lock.sqlite3")
	script := `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);try{db.exec('BEGIN EXCLUSIVE');process.exit(3)}catch{process.exit(0)}`
	if b, e := exec.Command(node, "-e", script, path).CombinedOutput(); e != nil {
		release()
		t.Fatal(e, string(b))
	}
	release()
	script = `const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('BEGIN EXCLUSIVE');console.log('ready');setInterval(()=>{},1000)`
	cmd := exec.CommandContext(context.Background(), node, "-e", script, path)
	out, e := cmd.StdoutPipe()
	if e != nil {
		t.Fatal(e)
	}
	if e = cmd.Start(); e != nil {
		t.Fatal(e)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	scanner := bufio.NewScanner(out)
	if !scanner.Scan() || scanner.Text() != "ready" {
		t.Fatal("Node lease did not start")
	}
	if other, e := storage.AcquireLease(home); e == nil {
		other()
		t.Fatal("Go overlapped Node")
	}
}

type blockingAnalysis struct {
	started chan struct{}
	release <-chan struct{}
}

func (b *blockingAnalysis) Models(context.Context) ([]p.Record, error) { return []p.Record{}, nil }
func (b *blockingAnalysis) Check(context.Context) error                { close(b.started); <-b.release; return nil }
func (b *blockingAnalysis) Analyze(context.Context, providers.AnalysisInput) (providers.AnalysisResult, error) {
	return providers.AnalysisResult{}, nil
}
func TestDrainingKeepsHealthAndLeaseUntilTasksExit(t *testing.T) {
	home := t.TempDir()
	release := make(chan struct{})
	analysis := &blockingAnalysis{started: make(chan struct{}), release: release}
	s, e := Start(Options{Home: home, Address: "127.0.0.1:0", RuntimeFactory: func(o runtime.Options) (*runtime.Runtime, error) { o.Analysis = analysis; return runtime.New(o) }})
	if e != nil {
		t.Fatal(e)
	}
	defer s.Close()
	call(t, s, "/v1/projects/p", "PUT", p.Record{"name": "p"})
	status, r := call(t, s, "/v1/projects/p/actions", "POST", p.Record{"action": "generation.check"})
	if status != 200 {
		t.Fatal(r)
	}
	<-analysis.started
	go s.Close()
	end := time.Now().Add(time.Second)
	for !s.draining.Load() {
		if time.Now().After(end) {
			t.Fatal("not draining")
		}
		time.Sleep(time.Millisecond)
	}
	status, r = call(t, s, "/health", "GET", nil)
	if status != 200 || r.S("state") != "draining" {
		t.Error(status, r)
	}
	status, _ = call(t, s, "/v1/projects/p/actions", "POST", p.Record{"action": "snapshot"})
	if status != 503 {
		t.Error(status)
	}
	if other, e := storage.AcquireLease(home); e == nil {
		other()
		t.Error("lease released before draining")
	}
	close(release)
	select {
	case <-s.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("draining did not finish")
	}
	other, e := storage.AcquireLease(home)
	if e != nil {
		t.Fatal(e)
	}
	other()
}
