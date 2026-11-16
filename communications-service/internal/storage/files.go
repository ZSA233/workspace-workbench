package storage

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"sync"
)

func Directory(path string) error {
	if err := os.MkdirAll(path, 0700); err != nil {
		return err
	}
	s, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
		return errors.New("storage_directory_invalid")
	}
	return os.Chmod(path, 0700)
}
func Regular(path string) error {
	s, e := os.Lstat(path)
	if e != nil {
		return e
	}
	if !s.Mode().IsRegular() {
		return errors.New("storage_file_invalid")
	}
	return nil
}
func Random(n int) []byte {
	b := make([]byte, n)
	if _, e := rand.Read(b); e != nil {
		panic(e)
	}
	return b
}
func ID() string {
	b := Random(16)
	b[6] = b[6]&15 | 64
	b[8] = b[8]&63 | 128
	s := hex.EncodeToString(b)
	return s[:8] + "-" + s[8:12] + "-" + s[12:16] + "-" + s[16:20] + "-" + s[20:]
}
func Atomic(path string, data []byte) error {
	temp := path + "." + ID()
	f, e := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if e != nil {
		return e
	}
	defer os.Remove(temp)
	if _, e = f.Write(data); e == nil {
		e = f.Sync()
	}
	closeErr := f.Close()
	if e != nil {
		return e
	}
	if closeErr != nil {
		return closeErr
	}
	if e = os.Rename(temp, path); e != nil {
		return e
	}
	d, e := os.Open(filepath.Dir(path))
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func ReadFile(path string, max int64) ([]byte, error) {
	if e := Regular(path); e != nil {
		return nil, e
	}
	s, e := os.Stat(path)
	if e != nil {
		return nil, e
	}
	if s.Size() > max {
		return nil, errors.New("storage_size_exceeded")
	}
	return os.ReadFile(path)
}

type Credentials struct {
	Root string
	mu   sync.Mutex
}

func (c *Credentials) key() ([]byte, error) {
	if e := Directory(c.Root); e != nil {
		return nil, e
	}
	path := filepath.Join(c.Root, "key")
	f, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e == nil {
		_, e = f.Write(Random(32))
		ce := f.Close()
		if e == nil {
			e = ce
		}
	}
	if e != nil && !os.IsExist(e) {
		return nil, e
	}
	b, e := ReadFile(path, 32)
	if e != nil {
		return nil, e
	}
	if len(b) != 32 {
		return nil, errors.New("credential_key_invalid")
	}
	if e = os.Chmod(path, 0600); e != nil {
		return nil, e
	}
	return b, nil
}

var credentialName = regexp.MustCompile(`^[a-z-]+$`)

func (c *Credentials) Get(name string) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !credentialName.MatchString(name) {
		return "", errors.New("credential_name_invalid")
	}
	b, e := ReadFile(filepath.Join(c.Root, name+".enc"), 32768)
	if os.IsNotExist(e) {
		return "", nil
	}
	if e != nil {
		return "", e
	}
	if len(b) < 28 {
		return "", errors.New("credential_file_invalid")
	}
	k, e := c.key()
	if e != nil {
		return "", e
	}
	block, e := aes.NewCipher(k)
	if e != nil {
		return "", e
	}
	g, e := cipher.NewGCM(block)
	if e != nil {
		return "", e
	}
	sealed := append(append([]byte{}, b[28:]...), b[12:28]...)
	plain, e := g.Open(nil, b[:12], sealed, nil)
	return string(plain), e
}
func (c *Credentials) Set(name, value string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !credentialName.MatchString(name) {
		return errors.New("credential_name_invalid")
	}
	k, e := c.key()
	if e != nil {
		return e
	}
	block, e := aes.NewCipher(k)
	if e != nil {
		return e
	}
	g, e := cipher.NewGCM(block)
	if e != nil {
		return e
	}
	iv := Random(12)
	sealed := g.Seal(nil, iv, []byte(value), nil)
	data := append(append(append([]byte{}, iv...), sealed[len(sealed)-16:]...), sealed[:len(sealed)-16]...)
	return Atomic(filepath.Join(c.Root, name+".enc"), data)
}
