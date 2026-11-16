package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"github.com/zsa233/workspace-workbench/communications-service/internal/httpapi"
	"io"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

func main() {
	if e := run(os.Args[1:]); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}
func run(args []string) error {
	command := "serve"
	if len(args) > 0 {
		command = args[0]
		args = args[1:]
	}
	if command == "version" {
		return json.NewEncoder(os.Stdout).Encode(map[string]any{"product": "project-communications-service", "version": httpapi.Version, "apiVersion": 1, "commit": httpapi.Commit, "buildTime": httpapi.BuildTime})
	}
	userHome, e := os.UserHomeDir()
	if e != nil {
		return e
	}
	home := os.Getenv("COMMUNICATIONS_HOME")
	if home == "" {
		home = filepath.Join(userHome, ".project-communications")
	}
	port := os.Getenv("COMMUNICATIONS_PORT")
	if port == "" {
		port = "47191"
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	flags.StringVar(&home, "home", home, "service data directory")
	flags.StringVar(&port, "port", port, "loopback HTTP port")
	if e = flags.Parse(args); e != nil {
		return e
	}
	if flags.NArg() != 0 {
		return errors.New("unexpected arguments")
	}
	number, e := strconv.Atoi(port)
	if e != nil || number < 1 || number > 65535 {
		return errors.New("invalid_port")
	}
	home, e = filepath.Abs(home)
	if e != nil {
		return e
	}
	if command == "serve" {
		service, e := httpapi.Start(httpapi.Options{Home: home, Address: "127.0.0.1:" + port})
		if e != nil {
			return e
		}
		ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer cancel()
		if e = json.NewEncoder(os.Stdout).Encode(map[string]any{"kind": "communications-service-ready", "url": service.URL, "home": home, "apiVersion": 1}); e != nil {
			service.Close()
			return e
		}
		select {
		case <-ctx.Done():
			service.Close()
		case <-service.Done():
		}
		return nil
	}
	token, e := httpapi.ServiceToken(home)
	if e != nil {
		return e
	}
	if command == "token" {
		fmt.Fprintln(os.Stdout, token)
		return nil
	}
	path, method := "", "GET"
	switch command {
	case "status":
		path = "/health"
	case "projects":
		path = "/v1/projects"
	case "stop":
		path = "/v1/shutdown"
		method = "POST"
	default:
		return errors.New("Usage: serve | status | projects | token | stop | version [--home PATH] [--port NUMBER]")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	request, e := http.NewRequestWithContext(ctx, method, "http://127.0.0.1:"+port+path, nil)
	if e != nil {
		return e
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, e := http.DefaultClient.Do(request)
	if e != nil {
		return errors.New("service_unreachable")
	}
	defer response.Body.Close()
	b, e := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if e != nil {
		return e
	}
	if len(b) > 1024*1024 {
		return errors.New("service_response_too_large")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("service_http_%d: %s", response.StatusCode, b)
	}
	_, e = os.Stdout.Write(append(b, '\n'))
	return e
}
