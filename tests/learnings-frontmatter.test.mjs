import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify } from '../src/lib/learnings/frontmatter.mjs';

const roundTrip = (input) => stringify(parse(input));

describe('learnings frontmatter parse/stringify', () => {
  it('完整 frontmatter（7 字段, lastHitAt: null）往返字节等价', () => {
    const input = `---
id: lesson-001
tags: [lesson, knowledge]
source: LESSONS.md
createdAt: 2026-09-14T10:00:00Z
hitCount: 3
lastHitAt: null
scope: team
---
body content here
`;
    assert.equal(roundTrip(input), input);
    assert.deepEqual(parse(input).frontmatter, {
      id: 'lesson-001',
      tags: ['lesson', 'knowledge'],
      source: 'LESSONS.md',
      createdAt: '2026-09-14T10:00:00Z',
      hitCount: 3,
      lastHitAt: null,
      scope: 'team',
    });
    assert.equal(parse(input).body, 'body content here\n');
  });

  it('tags 为空数组 tags: [] 往返字节等价', () => {
    const input = `---
id: empty-tags
tags: []
scope: private
---
some body
`;
    assert.equal(roundTrip(input), input);
    assert.deepEqual(parse(input).frontmatter, { id: 'empty-tags', tags: [], scope: 'private' });
  });

  it('无 frontmatter 返回 {frontmatter: {}, body: 原文}', () => {
    const input = 'just a body\nwith two lines\n';
    const r = parse(input);
    assert.deepEqual(r, { frontmatter: {}, body: input });
    assert.equal(stringify(r), input);
  });

  it('body 为空（仅 frontmatter 无正文）往返字节等价', () => {
    const input = `---
id: only-frontmatter
scope: team
---
`;
    assert.equal(roundTrip(input), input);
    assert.equal(parse(input).body, '');
  });

  it('hitCount=0 数字类型 + createdAt ISO8601 往返字节等价', () => {
    const input = `---
id: zero-hits
createdAt: 2026-09-14T10:00:00Z
hitCount: 0
lastHitAt: 2026-09-14T12:00:00Z
scope: team
---
`;
    assert.equal(roundTrip(input), input);
    const fm = parse(input).frontmatter;
    assert.equal(fm.hitCount, 0);
    assert.equal(typeof fm.hitCount, 'number');
    assert.equal(fm.createdAt, '2026-09-14T10:00:00Z');
    assert.equal(fm.lastHitAt, '2026-09-14T12:00:00Z');
  });

  it('stringify 独立构造 frontmatter 对象（含引号字符串与负引用）', () => {
    assert.equal(
      stringify({ frontmatter: { id: 'a b', tags: ['x'], hitCount: 0, lastHitAt: null }, body: 'tail' }),
      `---
id: "a b"
tags: [x]
hitCount: 0
lastHitAt: null
---
tail`
    );
  });
});
