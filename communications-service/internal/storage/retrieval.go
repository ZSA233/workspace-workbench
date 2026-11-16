package storage

import (
	"context"
	p "github.com/zsa233/workspace-workbench/communications-service/internal/protocol"
)

func (s *Store) SearchMessages(ctx context.Context, q string, limit int) ([]p.Message, error) {
	v, e := s.Do(ctx, func(t *Tx) (any, error) { return t.Messages(p.Record{"query": q}, int64(limit)), nil })
	if e != nil {
		return nil, e
	}
	return v.([]p.Message), nil
}
func (s *Store) RelatedRequirements(ctx context.Context, q string, limit int) ([]p.Requirement, error) {
	v, e := s.Do(ctx, func(t *Tx) (any, error) { return t.Related(q, limit), nil })
	if e != nil {
		return nil, e
	}
	return v.([]p.Requirement), nil
}
