package storage

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// Keep the exact SQLite lock used by Node v1. A separate flock would allow two owners.
func AcquireLease(root string) (func(), error) {
	if e := Directory(root); e != nil {
		return nil, e
	}
	path := filepath.Join(root, ".backend-lock.sqlite3")
	if _, e := os.Lstat(path); e == nil {
		if e = Regular(path); e != nil {
			return nil, e
		}
	}
	db, e := sql.Open("sqlite", path)
	if e != nil {
		return nil, e
	}
	db.SetMaxOpenConns(1)
	conn, e := db.Conn(context.Background())
	if e != nil {
		db.Close()
		return nil, e
	}
	if _, e = conn.ExecContext(context.Background(), "BEGIN EXCLUSIVE"); e != nil {
		conn.Close()
		db.Close()
		return nil, errors.New("observer_busy: another process owns this service's records, or the lease is unavailable")
	}
	if e = os.Chmod(path, 0600); e != nil {
		conn.Close()
		db.Close()
		return nil, e
	}
	var once sync.Once
	return func() {
		once.Do(func() { conn.ExecContext(context.Background(), "ROLLBACK"); conn.Close(); db.Close() })
	}, nil
}
