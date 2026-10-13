/**
 * jev-precheck-lib.test.mjs — src/lib/jev-precheck.mjs 纯逻辑单测 (jev-redline-precheck T03)
 *
 * 通过注入 fetchImpl 覆盖: 开关判定 / 命中 / 未命中 / 四类失败 / 外发内容 / key 不泄露。
 * 不连接真实 api.typesafe.ai。CLI 端到端用例见 tests/jev-precheck.test.mjs。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldUseJev,
  runJevPrecheck,
  renderJevLine,
  JEV_MODEL,
  JEV_THRESHOLD,
  JEV_TIMEOUT_MS,
  JEV_DEFAULT_BASE_URL,
  JEV_QUESTIONS,
} from '../src/lib/jev-precheck.mjs';

const KEY = 'sk-test-0123456789abcdef';
const DESC = '把订单状态的写入改成先发消息再落库';

function jsonResponse(status, payload) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function answer(noul, choice = 'concurrency', model = JEV_MODEL) {
  return { model, answers: { risky: { type: 'noul', noul }, category: { type: 'choice', choice } } };
}

/** 记录调用并返回固定响应的 fetch 替身 */
function recordingFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return typeof response === 'function' ? response(url, init) : response;
  };
  return { impl, calls };
}

describe('常量', () => {
  it('固定模型、阈值、超时与官方地址 (D3 / D6)', () => {
    assert.equal(JEV_MODEL, 'jev-1.13.0');
    assert.equal(JEV_THRESHOLD, 0.5);
    assert.equal(JEV_TIMEOUT_MS, 3000);
    assert.equal(JEV_DEFAULT_BASE_URL, 'https://api.typesafe.ai');
  });

  it('问题集为 noul risky + choice category,choice 含 none (D4)', () => {
    assert.equal(JEV_QUESTIONS.risky.type, 'noul');
    assert.ok(JEV_QUESTIONS.risky.criteria.true && JEV_QUESTIONS.risky.criteria.false);
    assert.equal(JEV_QUESTIONS.category.type, 'choice');
    assert.ok('none' in JEV_QUESTIONS.category.criteria);
  });
});

describe('shouldUseJev · 前置判断 (AC-1 / AC-2)', () => {
  it('未配置 jev 或 enabled !== true → 不调用且不提示', () => {
    for (const config of [{}, { jev: {} }, { jev: { enabled: false } }, null]) {
      assert.deepEqual(shouldUseJev(config, { TYPESAFE_API_KEY: KEY }), { use: false, warn: null });
    }
  });

  it('enabled=true 但 key 为空 / 纯空白 / 缺失 → 不调用,带一行含 TYPESAFE_API_KEY 的提示', () => {
    for (const env of [{}, { TYPESAFE_API_KEY: '' }, { TYPESAFE_API_KEY: '   ' }]) {
      const r = shouldUseJev({ jev: { enabled: true } }, env);
      assert.equal(r.use, false);
      assert.match(r.warn, /TYPESAFE_API_KEY/);
      assert.equal(r.warn.split('\n').length, 1);
    }
  });

  it('enabled=true 且有 key → 调用,baseURL 缺省为官方地址', () => {
    assert.deepEqual(
      shouldUseJev({ jev: { enabled: true } }, { TYPESAFE_API_KEY: ` ${KEY} ` }),
      { use: true, apiKey: KEY, baseURL: JEV_DEFAULT_BASE_URL },
    );
  });

  it('TYPESAFE_BASE_URL 覆盖接口根地址 (D8)', () => {
    const r = shouldUseJev({ jev: { enabled: true } }, { TYPESAFE_API_KEY: KEY, TYPESAFE_BASE_URL: 'http://127.0.0.1:9' });
    assert.equal(r.baseURL, 'http://127.0.0.1:9');
  });
});

describe('runJevPrecheck · 判定 (AC-3 / AC-4)', () => {
  it('noul ≥ 0.5 → hit=true,带概率 / 类别 / 模型', async () => {
    const { impl } = recordingFetch(jsonResponse(200, answer(0.94)));
    const r = await runJevPrecheck(DESC, { apiKey: KEY, baseURL: JEV_DEFAULT_BASE_URL, fetchImpl: impl });
    assert.deepEqual(r, { ok: true, hit: true, p: 0.94, category: 'concurrency', model: JEV_MODEL });
  });

  it('noul 恰为 0.5 → hit=true (阈值含等号)', async () => {
    const { impl } = recordingFetch(jsonResponse(200, answer(0.5)));
    const r = await runJevPrecheck(DESC, { apiKey: KEY, baseURL: 'http://x', fetchImpl: impl });
    assert.equal(r.hit, true);
  });

  it('noul < 0.5 → hit=false', async () => {
    const { impl } = recordingFetch(jsonResponse(200, answer(0.12, 'none')));
    const r = await runJevPrecheck(DESC, { apiKey: KEY, baseURL: 'http://x', fetchImpl: impl });
    assert.equal(r.ok, true);
    assert.equal(r.hit, false);
    assert.equal(r.category, 'none');
  });
});

describe('runJevPrecheck · 失败归类,不抛错、不重试 (AC-6)', () => {
  it('超时 → timeout,只调用一次', async () => {
    let n = 0;
    const impl = (url, init) => {
      n += 1;
      return new Promise((_, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    };
    const r = await runJevPrecheck(DESC, { apiKey: KEY, baseURL: 'http://x', fetchImpl: impl, timeoutMs: 30 });
    assert.deepEqual(r, { ok: false, error: 'timeout' });
    assert.equal(n, 1);
  });

  for (const status of [401, 500]) {
    it(`HTTP ${status} → "http ${status}",只调用一次`, async () => {
      const { impl, calls } = recordingFetch(jsonResponse(status, { error: 'x' }));
      const r = await runJevPrecheck(DESC, { apiKey: KEY, baseURL: 'http://x', fetchImpl: impl });
      assert.deepEqual(r, { ok: false, error: `http ${status}` });
      assert.equal(calls.length, 1);
    });
  }

  it('连接失败 → network', async () => {
    const impl = async () => { throw new TypeError('fetch failed'); };
    const r = await runJevPrecheck(DESC, { apiKey: KEY, baseURL: 'http://x', fetchImpl: impl });
    assert.deepEqual(r, { ok: false, error: 'network' });
  });

  it('响应不是 JSON / 缺 answers.risky.noul → bad-response', async () => {
    const notJson = { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } };
    for (const res of [notJson, jsonResponse(200, {}), jsonResponse(200, answer('0.9'))]) {
      const r = await runJevPrecheck(DESC, { apiKey: KEY, baseURL: 'http://x', fetchImpl: async () => res });
      assert.deepEqual(r, { ok: false, error: 'bad-response' });
    }
  });

  it('失败结果与渲染行都不含 apiKey', async () => {
    const impl = async () => { throw new TypeError(`fetch failed for ${KEY}`); };
    const r = await runJevPrecheck(DESC, { apiKey: KEY, baseURL: 'http://x', fetchImpl: impl });
    assert.ok(!JSON.stringify(r).includes(KEY));
    assert.ok(!renderJevLine(r).includes(KEY));
  });
});

describe('runJevPrecheck · 外发内容 (AC-7)', () => {
  it('POST {baseURL}/v1/systemone,Bearer 鉴权,body 只含固定 model + 描述 + 问题', async () => {
    const { impl, calls } = recordingFetch(jsonResponse(200, answer(0.2)));
    await runJevPrecheck(DESC, { apiKey: KEY, baseURL: 'http://127.0.0.1:9/', fetchImpl: impl });

    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, 'http://127.0.0.1:9/v1/systemone');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.authorization, `Bearer ${KEY}`);
    assert.equal(init.headers['content-type'], 'application/json');

    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
    assert.equal(body.model, JEV_MODEL);
    assert.deepEqual(body.state, { change_description: DESC });
    assert.deepEqual(body.questions, JEV_QUESTIONS);
    assert.ok(!init.body.includes(KEY), 'key 只出现在请求头');
  });
});

describe('renderJevLine (D7)', () => {
  it('成功: 两位小数概率 + 类别 + 模型', () => {
    assert.equal(
      renderJevLine({ ok: true, hit: true, p: 0.9412, category: 'auth', model: JEV_MODEL }),
      'jev: p=0.94 category=auth model=jev-1.13.0',
    );
  });

  it('缺类别 / 模型时用 -', () => {
    assert.equal(renderJevLine({ ok: true, hit: false, p: 0.1, category: null, model: null }), 'jev: p=0.10 category=- model=-');
  });

  it('失败: jev: error <分类>', () => {
    assert.equal(renderJevLine({ ok: false, error: 'http 500' }), 'jev: error http 500');
  });
});
