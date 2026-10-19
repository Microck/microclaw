import { expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexProvider } from './codex.js';

it('discovers every page and applies model and reasoning to resumed threads and turns', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-model-rpc-'));
  const saved = {
    PATH: process.env.PATH,
    CODEX_HOME: process.env.CODEX_HOME,
    NANOCLAW_AGENT_DIR: process.env.NANOCLAW_AGENT_DIR,
  };
  try {
    fs.writeFileSync(
      path.join(root, 'codex'),
      `#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
const reply = value => console.log(JSON.stringify(value));
const entry = model => ({id:model,model,isDefault:false,defaultReasoningEffort:'medium',supportedReasoningEfforts:['low','medium','ultra'].map(reasoningEffort=>({reasoningEffort}))});
createInterface({input:process.stdin}).on('line', line => {
 const request=JSON.parse(line);
 fs.appendFileSync(path.join(process.env.CODEX_HOME, 'rpc.jsonl'), line+'\\n');
 if(request.id===undefined)return;
 let result={};
 if(request.method==='model/list')result=request.params.cursor ? {data:[entry('gpt-6.1-sol'),...(request.params.includeHidden ? [entry('gpt-reserve')] : [])],nextCursor:null} : {data:[entry('gpt-6-sol')],nextCursor:'second'};
 if(request.method==='thread/resume' && request.params.threadId.endsWith('retry-thread') && !fs.existsSync(path.join(process.env.CODEX_HOME,request.params.threadId))){
 fs.writeFileSync(path.join(process.env.CODEX_HOME,request.params.threadId),'1');
 reply({id:request.id,error:{message:'workspace routing discovery timed out'}});return;
 }
 if(request.method==='thread/resume' && ['always-fail','auth-failure'].includes(request.params.threadId)){
 reply({id:request.id,error:{message:request.params.threadId==='auth-failure' ? 'unauthorized' : 'workspace routing discovery timed out'}});return;
 }
 if(request.method==='thread/resume')result={thread:{id:request.params.threadId}};
 if(request.method==='turn/start')result={turn:{id:'turn-test'}};
 reply({id:request.id,result});
 if(request.method==='turn/start' && request.params.input[0].text==='terminal failure'){
 reply({method:'error',params:{willRetry:false,error:{message:'Terminal transport failure'}}});return;
 }
 if(request.method==='turn/start')reply({method:'error',params:{willRetry:true,error:{message:'Reconnecting... 2/5'}}});
 if(request.method==='turn/start')setTimeout(()=>reply({method:'turn/completed',params:{turn:{items:[{type:'agentMessage',text:'synthetic answer'}]}}}),5);
});
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${root}:${saved.PATH}`;
    process.env.CODEX_HOME = root;
    process.env.NANOCLAW_AGENT_DIR = root;
    const provider = new CodexProvider({ model: 'gpt-6-luna', effort: 'xhigh' });
    provider.registerMemorySessionHook({ command: 'true', legacyCommands: [], sources: [] });
    expect((await provider.configureModel('sol medium')).model).toBe('gpt-6.1-sol');
    const results: string[] = [];
    const turn = async () => {
      const query = provider.query({ prompt: 'synthetic input', continuation: 'existing-thread', cwd: root });
      for await (const event of query.events)
        if (event.type === 'result') {
          results.push(event.text ?? '');
          query.end();
        }
    };
    await turn();
    await provider.configureModel('sol ultra');
    await turn();
    await expect(provider.configureModel('sol high')).rejects.toThrow('does not support');
    await turn();
    expect((await provider.configureModel('gpt-reserve')).model).toBe('gpt-reserve');
    await turn();
    expect(results).toEqual(Array(4).fill('synthetic answer'));
    const requests = fs
      .readFileSync(path.join(root, 'rpc.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const resumes = requests.filter((request) => request.method === 'thread/resume');
    expect(resumes.map((request) => ({ threadId: request.params.threadId, model: request.params.model }))).toEqual([
      ...Array(3).fill({ threadId: 'existing-thread', model: 'gpt-6.1-sol' }),
      { threadId: 'existing-thread', model: 'gpt-reserve' },
    ]);
    expect(
      requests
        .filter((request) => request.method === 'turn/start')
        .map((request) => ({ model: request.params.model, effort: request.params.effort })),
    ).toEqual([
      { model: 'gpt-6.1-sol', effort: 'medium' },
      { model: 'gpt-6.1-sol', effort: 'ultra' },
      { model: 'gpt-6.1-sol', effort: 'ultra' },
      { model: 'gpt-reserve', effort: 'low' },
    ]);
    expect(requests.some((request) => request.method === 'thread/start')).toBe(false);
    const failed = provider.query({ prompt: 'terminal failure', continuation: 'existing-thread', cwd: root });
    const failures: string[] = [];
    const collectFailure = async () => {
      for await (const event of failed.events) failures.push(event.type);
    };
    await expect(collectFailure()).rejects.toThrow('Terminal transport failure');
    expect(failures.filter((type) => type === 'error')).toHaveLength(1);
    expect(failures).not.toContain('result');
    const retry = provider.query({ prompt: 'safe startup retry', continuation: 'retry-thread', cwd: root });
    const retryResults: string[] = [];
    for await (const event of retry.events)
      if (event.type === 'result') {
        retryResults.push(event.text ?? '');
        retry.end();
      }
    expect(retryResults).toEqual(['synthetic answer']);
    const cancelled = provider.query({ prompt: 'do not send', continuation: 'abort-retry-thread', cwd: root });
    for await (const event of cancelled.events) {
      if (event.type === 'progress') cancelled.abort();
      expect(event.type).not.toBe('result');
    }

    for (const [thread, message] of [
      ['always-fail', 'routing discovery timed out'],
      ['auth-failure', 'unauthorized'],
    ]) {
      const failure = provider.query({ prompt: 'do not replay', continuation: thread, cwd: root });
      const consume = async () => {
        for await (const event of failure.events) expect(event.type).not.toBe('result');
      };
      await expect(consume()).rejects.toThrow(message);
    }
    const retriedRequests = fs
      .readFileSync(path.join(root, 'rpc.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(
      retriedRequests.filter(
        (request) => request.method === 'thread/resume' && request.params.threadId === 'retry-thread',
      ),
    ).toHaveLength(2);
    expect(
      retriedRequests.filter(
        (request) => request.method === 'turn/start' && request.params.threadId === 'retry-thread',
      ),
    ).toHaveLength(1);
    expect(
      retriedRequests.filter(
        (request) => request.method === 'thread/resume' && request.params.threadId === 'abort-retry-thread',
      ),
    ).toHaveLength(1);
    expect(
      retriedRequests.some(
        (request) => request.method === 'turn/start' && request.params.threadId === 'abort-retry-thread',
      ),
    ).toBe(false);
    for (const [thread, attempts] of [
      ['always-fail', 2],
      ['auth-failure', 1],
    ] as const) {
      expect(
        retriedRequests.filter((request) => request.method === 'thread/resume' && request.params.threadId === thread),
      ).toHaveLength(attempts);
      expect(
        retriedRequests.some((request) => request.method === 'turn/start' && request.params.threadId === thread),
      ).toBe(false);
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 10000);
