import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Audience, DraftBatch, DraftQuestion, PackMeta, SourceId } from '../../../shared/packs';
import { MIN_PASSWORD } from '../../../shared/protocol';
import '../shared/styles.css';
import { Toast } from '../shared/ui';

/**
 * The question bank editor.
 *
 * The whole screen is built around one idea: generated questions are drafts
 * until a person says otherwise. Nothing here can put a question in front of a
 * room without someone reading it and pressing approve, and anything the
 * verification pass doubted arrives already rejected — so the failure mode of
 * a distracted reviewer is a smaller pack, never a wrong answer on the screen.
 */

interface Context {
  credentials: boolean;
  models: Array<{ id: string; name: string; inPerM: number; outPerM: number; blurb: string }>;
  defaultModel: string;
  audiences: Array<{ id: Audience; name: string; blurb: string }>;
  maxBatch: number;
  sources: Array<{ id: SourceId; name: string; blurb: string; cost: string }>;
  categories: Array<{
    id: string; name: string; blurb: string; count: number;
    /** False when the import source has no counterpart for this category. */
    importable: boolean;
    importBlockedReason?: string;
  }>;
  packs: PackMeta[];
  batches: Array<{
    id: string; created: string; category: string; audience: Audience;
    model: string; costCents: number; total: number; pending: number; approved: number;
  }>;
}

const DIFFICULTY_PRESETS: Array<{ label: string; mix: Array<1 | 2 | 3 | 4>; blurb: string }> = [
  { label: 'Balanced', mix: [2, 2, 3, 3, 4, 3, 3, 4], blurb: 'Matches the shipped packs' },
  { label: 'Gentler', mix: [1, 2, 2, 3, 2, 3], blurb: 'Mixed or new crowd' },
  { label: 'Hard', mix: [3, 3, 4, 4, 3, 4], blurb: 'Regulars who want a fight' },
];

function money(cents: number): string {
  if (cents < 1) return '<1¢';
  if (cents < 100) return `${Math.round(cents)}¢`;
  return `$${(cents / 100).toFixed(2)}`;
}

function api(token: string) {
  return async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetch(path, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
    });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
    return body as T;
  };
}

function Login({ onToken }: { onToken: (t: string) => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  return (
    <div class="shell">
      <div class="card stack">
        <div class="eyebrow">Question bank</div>
        <h1>Host password</h1>
        <p class="muted">The same password as the MC controls, set on the server.</p>
        <input
          value={password}
          onInput={(e) => setPassword((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit(); }}
          type="password"
          autocomplete="current-password"
          placeholder="Host password"
          style={{ fontSize: '1.5rem', textAlign: 'center' }}
        />
        {error && <p class="pill pill-bad">{error}</p>}
        <button class="btn btn-primary btn-lg btn-block" disabled={password.length < MIN_PASSWORD} onClick={() => void submit()}>
          Unlock
        </button>
      </div>
    </div>
  );

  async function submit() {
    setError('');
    try {
      const res = await fetch('/api/control/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) { setError('That password is not right.'); return; }
      const { token } = (await res.json()) as { token: string };
      localStorage.setItem('primetime.controlToken', token);
      onToken(token);
    } catch {
      setError('Could not reach the server.');
    }
  }
}

function NoCredentials() {
  return (
    <div class="card stack">
      <div class="eyebrow">Not set up yet</div>
      <h1>No API key</h1>
      <p class="muted">
        Generating questions calls the Claude API, so this machine needs a key and an internet
        connection. The game itself needs neither — write packs at home, play them offline.
      </p>
      <pre style={{
        background: 'var(--ink)', border: '1px solid var(--line)', borderRadius: '12px',
        padding: '14px', overflowX: 'auto', fontSize: '.9rem',
      }}>
        export ANTHROPIC_API_KEY=sk-ant-...{'\n'}
        npm start
      </pre>
      <p class="faint">
        Get a key at console.anthropic.com. Restart the server after setting it, then reload this page.
      </p>
    </div>
  );
}

function GenerateForm({
  context, onGenerated, setToast,
}: {
  context: Context;
  onGenerated: (batch: DraftBatch) => void;
  setToast: (m: string) => void;
}) {
  const [source, setSource] = useState<SourceId>('claude');
  const [audience, setAudience] = useState<Audience>('35-75');
  const [category, setCategory] = useState(context.categories[0]?.id ?? '');
  const [count, setCount] = useState(10);
  const [preset, setPreset] = useState(0);
  const [guidance, setGuidance] = useState('');
  const [model, setModel] = useState(context.defaultModel);
  const [busy, setBusy] = useState(false);

  const chosen = context.models.find((m) => m.id === model) ?? context.models[0]!;
  const importing = source === 'opentdb';
  const categoryInfo = context.categories.find((c) => c.id === category);
  const categoryBlocked = importing && !!categoryInfo && !categoryInfo.importable;
  const importableCount = context.categories.filter((c) => c.importable).length;

  // Rough, and labelled as rough. Input is dominated by the existing-prompts
  // list we send for dedupe; output by the questions themselves. An import
  // writes no questions, so it pays only for the reveal lines and the check.
  const estIn = importing ? 400 + count * 70 : 2000 + count * 60;
  const estOut = importing ? count * 120 : count * 220;
  const estimate = ((estIn / 1e6) * chosen.inPerM + (estOut / 1e6) * chosen.outPerM) * 100 * 2;

  /**
   * Switching to the import source with an unsupported category selected
   * would arm a button that can only fail, so move to one that works and
   * leave the explanation on the chip the MC just lost.
   */
  function pickSource(next: SourceId) {
    setSource(next);
    if (next === 'opentdb' && categoryInfo && !categoryInfo.importable) {
      setCategory(context.categories.find((c) => c.importable)?.id ?? category);
    }
  }

  return (
    <div class="card stack">
      <div class="eyebrow">{importing ? 'Import a new batch' : 'Write a new batch'}</div>

      <div class="field">
        <span>Where the questions come from</span>
        <div class="chips">
          {context.sources.map((src) => (
            <button key={src.id} class="chip" aria-pressed={source === src.id} onClick={() => pickSource(src.id)}>
              {src.name}
            </button>
          ))}
        </div>
        <span class="faint">{context.sources.find((src) => src.id === source)?.blurb}</span>
      </div>

      <div class="field">
        <span>Who is playing</span>
        <div class="chips">
          {context.audiences.map((a) => (
            <button key={a.id} class="chip" aria-pressed={audience === a.id} onClick={() => setAudience(a.id)}>
              {a.name}
            </button>
          ))}
        </div>
        <span class="faint">{context.audiences.find((a) => a.id === audience)?.blurb}</span>
      </div>

      <div class="field">
        <span>Category</span>
        <div class="chips">
          {context.categories.map((c) => {
            const blocked = importing && !c.importable;
            return (
              <button
                key={c.id}
                class="chip"
                aria-pressed={category === c.id}
                disabled={blocked}
                title={blocked ? c.importBlockedReason : c.blurb}
                onClick={() => setCategory(c.id)}
              >
                {c.name} <span class="faint">{c.count}</span>
              </button>
            );
          })}
        </div>
        {importing && (
          <span class="faint">
            {importableCount} of {context.categories.length} categories have an Open Trivia DB counterpart.
            The rest are greyed out; hover one to see why.
          </span>
        )}
      </div>

      <div class="field">
        <span>How many — {count}</span>
        <div class="chips">
          {[5, 10, 15, 20].map((n) => (
            <button key={n} class="chip" aria-pressed={count === n} onClick={() => setCount(n)} disabled={n > context.maxBatch}>
              {n}
            </button>
          ))}
        </div>
      </div>

      <div class="field">
        <span>Difficulty</span>
        <div class="chips">
          {DIFFICULTY_PRESETS.map((p, i) => (
            <button key={p.label} class="chip" aria-pressed={preset === i} onClick={() => setPreset(i)}>
              {p.label}
            </button>
          ))}
        </div>
        <span class="faint">{DIFFICULTY_PRESETS[preset]!.blurb}</span>
      </div>

      {!importing && (
      <div class="field">
        <span>Anything specific? (optional)</span>
        <textarea
          value={guidance}
          onInput={(e) => setGuidance((e.target as HTMLTextAreaElement).value)}
          placeholder="e.g. focus on the Apollo programme, or avoid anything about aircraft"
          maxLength={400}
        />
      </div>
      )}

      <div class="field">
        <span>{importing ? 'Model for the reveal lines' : 'Model'}</span>
        <div class="chips">
          {context.models.map((m) => (
            <button key={m.id} class="chip" aria-pressed={model === m.id} onClick={() => setModel(m.id)}>
              {m.name}
            </button>
          ))}
        </div>
        <span class="faint">{chosen.blurb}</span>
      </div>

      {importing && DIFFICULTY_PRESETS[preset]!.mix.includes(4) && (
        <p class="faint">
          Open Trivia DB has no difficulty 4. Slots asking for one will hold its hardest instead.
        </p>
      )}

      <p class="faint">
        {importing
          ? `Roughly ${money(estimate)} for this batch. The questions are free; this is the reveal
             lines and the fact-check, which an import still needs. A rough estimate, not a quote.`
          : `Roughly ${money(estimate)} for this batch — two calls, one to write and one to
             fact-check. A rough estimate, not a quote.`}
      </p>

      <button
        class="btn btn-primary btn-lg btn-block"
        disabled={busy || !category || categoryBlocked}
        onClick={generate}
      >
        {busy
          ? <><span class="spinner" /> {importing ? 'Importing and checking…' : 'Writing and checking…'}</>
          : importing ? `Import ${count} questions` : `Write ${count} questions`}
      </button>
      {busy && <p class="faint center">This takes a minute or two. Leave the page open.</p>}
    </div>
  );

  async function generate() {
    setBusy(true);
    try {
      const token = localStorage.getItem('primetime.controlToken') ?? '';
      const batch = await api(token)<DraftBatch>('/api/author/generate', {
        method: 'POST',
        body: JSON.stringify({
          audience, category, count,
          difficulties: DIFFICULTY_PRESETS[preset]!.mix,
          guidance: importing ? undefined : guidance.trim() || undefined,
          model,
          source,
        }),
      });
      onGenerated(batch);
    } catch (err) {
      setToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
}

function DraftCard({
  draft, categoryName, onChange,
}: {
  draft: DraftQuestion;
  categoryName: string;
  onChange: (update: Partial<DraftQuestion> & { id: string }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const options = [draft.answer, ...draft.distractors];

  return (
    <div class="draft" data-verdict={draft.verdict} data-status={draft.status}>
      <div class="row-between">
        <span class="faint">{categoryName} · difficulty {draft.difficulty}</span>
        <span class={`pill ${draft.verdict === 'correct' ? 'pill-ok' : draft.verdict === 'unchecked' ? '' : 'pill-bad'}`}>
          {draft.verdict === 'correct' ? 'checked' : draft.verdict}
        </span>
      </div>

      {editing ? (
        <div class="stack">
          <textarea value={draft.prompt} onInput={(e) => onChange({ id: draft.id, prompt: (e.target as HTMLTextAreaElement).value })} />
          <input value={draft.answer} onInput={(e) => onChange({ id: draft.id, answer: (e.target as HTMLInputElement).value })} />
          {draft.distractors.map((d, i) => (
            <input
              key={i}
              value={d}
              onInput={(e) => {
                const next = draft.distractors.slice();
                next[i] = (e.target as HTMLInputElement).value;
                onChange({ id: draft.id, distractors: next });
              }}
            />
          ))}
          <textarea value={draft.fact} onInput={(e) => onChange({ id: draft.id, fact: (e.target as HTMLTextAreaElement).value })} />
        </div>
      ) : (
        <>
          <p style={{ fontFamily: 'var(--serif)', fontSize: '1.15rem', margin: 0 }}>{draft.prompt}</p>
          <div class="draft-options">
            {options.map((o, i) => (
              <div key={i} class={`draft-option${i === 0 ? ' is-answer' : ''}`}>
                {o}{i === 0 ? ' ✓' : ''}
              </div>
            ))}
          </div>
          <p class="faint" style={{ margin: 0 }}>{draft.fact}</p>
        </>
      )}

      {draft.verdictNote && (
        <div class="note">
          <strong>Fact-check:</strong> {draft.verdictNote}
          {draft.suggestedAnswer && <> Suggested answer: <strong>{draft.suggestedAnswer}</strong>.</>}
        </div>
      )}

      <div class="grid3">
        <button
          class={`btn btn-sm${draft.status === 'approved' ? ' btn-primary' : ''}`}
          onClick={() => onChange({ id: draft.id, status: draft.status === 'approved' ? 'pending' : 'approved' })}
        >
          {draft.status === 'approved' ? 'Approved' : 'Approve'}
        </button>
        <button
          class={`btn btn-sm${draft.status === 'rejected' ? ' btn-danger' : ''}`}
          onClick={() => onChange({ id: draft.id, status: draft.status === 'rejected' ? 'pending' : 'rejected' })}
        >
          {draft.status === 'rejected' ? 'Rejected' : 'Reject'}
        </button>
        <button class="btn btn-sm" onClick={() => setEditing(!editing)}>{editing ? 'Done' : 'Edit'}</button>
      </div>
    </div>
  );
}

function Review({
  batch, context, onDone, setToast,
}: {
  batch: DraftBatch;
  context: Context;
  onDone: () => void;
  setToast: (m: string) => void;
}) {
  const [draft, setDraft] = useState(batch);
  const [name, setName] = useState('');
  const [reviewedBy, setReviewedBy] = useState(() => localStorage.getItem('primetime.reviewer') ?? '');
  const [appendTo, setAppendTo] = useState('');
  const [busy, setBusy] = useState(false);

  const approved = draft.questions.filter((q) => q.status === 'approved').length;
  const pending = draft.questions.filter((q) => q.status === 'pending').length;
  const categoryName = context.categories.find((c) => c.id === draft.category)?.name ?? draft.category;
  const token = localStorage.getItem('primetime.controlToken') ?? '';

  return (
    <div class="stack">
      <div class="card stack">
        <div class="row-between">
          <div>
            <div class="eyebrow">Review</div>
            <strong>{categoryName}</strong>
            <span class="faint">
              {' · '}{draft.questions.length} {draft.source === 'opentdb' ? 'imported' : 'written'}
              {' · '}{money(draft.costCents)} spent
            </span>
          </div>
          <button class="btn btn-sm" onClick={onDone}>Back</button>
        </div>
        <p class="muted">
          Anything the fact-check doubted is already rejected. Read each one, then approve what you'd
          be happy reading out loud.
          {draft.source === 'opentdb' && ' These came from a public database and were not written to ' +
            'this project\'s standard, so expect to reject more of them than usual — a distractor ' +
            'nobody would pick is reason enough.'}
        </p>
        {draft.source === 'opentdb' && (
          <p class="faint">
            Imported from the Open Trivia Database (opentdb.com), CC BY-SA 4.0. The source and licence
            are recorded on every question that gets published.
          </p>
        )}
        {(draft.notes ?? []).map((note) => (
          <p key={note} class="faint">{note}</p>
        ))}
        <div class="row" style={{ gap: '10px', flexWrap: 'wrap' }}>
          <span class="pill pill-ok">{approved} approved</span>
          <span class="pill">{pending} undecided</span>
          <span class="pill pill-bad">{draft.questions.length - approved - pending} rejected</span>
        </div>
        {draft.rejectedDuplicates.length > 0 && (
          <p class="faint">
            {draft.rejectedDuplicates.length} duplicate{draft.rejectedDuplicates.length === 1 ? '' : 's'} of
            existing questions were dropped before you saw them.
          </p>
        )}
      </div>

      {draft.questions.map((q) => (
        <DraftCard key={q.id} draft={q} categoryName={categoryName} onChange={update} />
      ))}

      <div class="card stack">
        <div class="eyebrow">Publish approved questions</div>
        <label class="field">
          <span>Pack name</span>
          <input value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} placeholder="Sixties Music" maxLength={60} />
        </label>
        <label class="field">
          <span>Reviewed by — recorded in the file</span>
          <input value={reviewedBy} onInput={(e) => setReviewedBy((e.target as HTMLInputElement).value)} placeholder="Your name" maxLength={40} />
        </label>
        {context.packs.length > 0 && (
          <label class="field">
            <span>Or add to an existing pack</span>
            <div class="chips">
              <button class="chip" aria-pressed={!appendTo} onClick={() => setAppendTo('')}>New pack</button>
              {context.packs.map((p) => (
                <button key={p.id} class="chip" aria-pressed={appendTo === p.id} onClick={() => setAppendTo(p.id)}>
                  {p.name} <span class="faint">{p.questionCount}</span>
                </button>
              ))}
            </div>
          </label>
        )}
      </div>

      <div class="bar">
        <button
          class="btn btn-primary btn-lg grow"
          disabled={busy || !approved || !reviewedBy.trim() || (!name.trim() && !appendTo)}
          onClick={publish}
        >
          {busy ? <span class="spinner" /> : `Publish ${approved} question${approved === 1 ? '' : 's'}`}
        </button>
        <button class="btn btn-danger" onClick={discard}>Discard</button>
      </div>
    </div>
  );

  function update(change: Partial<DraftQuestion> & { id: string }) {
    const next = {
      ...draft,
      questions: draft.questions.map((q) => (q.id === change.id ? { ...q, ...change } : q)),
    };
    setDraft(next);
    void api(token)(`/api/author/batch/${draft.id}/review`, {
      method: 'POST',
      body: JSON.stringify({ updates: [change] }),
    }).catch((err: Error) => setToast(err.message));
  }

  async function publish() {
    setBusy(true);
    try {
      localStorage.setItem('primetime.reviewer', reviewedBy.trim());
      const result = await api(token)<{ pack: PackMeta; reload: { ok: boolean; message: string } }>(
        `/api/author/batch/${draft.id}/publish`,
        {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim() || appendTo,
            reviewedBy: reviewedBy.trim(),
            appendTo: appendTo || undefined,
          }),
        },
      );
      setToast(`Saved to ${result.pack.name}. ${result.reload.message}`);
      onDone();
    } catch (err) {
      setToast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function discard() {
    if (!confirm('Throw this batch away? The questions are not saved anywhere else.')) return;
    try {
      await api(token)(`/api/author/batch/${draft.id}`, { method: 'DELETE' });
      onDone();
    } catch (err) {
      setToast((err as Error).message);
    }
  }
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('primetime.controlToken'));
  const [context, setContext] = useState<Context | null>(null);
  const [batch, setBatch] = useState<DraftBatch | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    void load();
  }, [token]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  if (!token) return <Login onToken={setToken} />;

  if (error) {
    return (
      <div class="author">
        <div class="card stack">
          <div class="eyebrow">Problem</div>
          <p>{error}</p>
          <button class="btn" onClick={() => { localStorage.removeItem('primetime.controlToken'); setToken(null); }}>
            Enter the password again
          </button>
        </div>
      </div>
    );
  }

  if (!context) return <div class="author"><div class="card center"><p class="muted">Loading…</p></div></div>;

  return (
    <div class="author">
      <div class="row-between">
        <div>
          <div class="eyebrow">PrimeTime Trivia</div>
          <strong>Question bank</strong>
        </div>
        <a class="btn btn-sm" href="/control">MC controls</a>
      </div>

      {!context.credentials && <NoCredentials />}

      {batch ? (
        <Review batch={batch} context={context} setToast={setToast} onDone={() => { setBatch(null); void load(); }} />
      ) : (
        <>
          {context.credentials && <GenerateForm context={context} setToast={setToast} onGenerated={setBatch} />}

          {context.batches.length > 0 && (
            <div class="card stack">
              <div class="eyebrow">Waiting for review</div>
              {context.batches.map((b) => (
                <button key={b.id} class="row-between" style={{ width: '100%', textAlign: 'left' }} onClick={() => void open(b.id)}>
                  <span class="grow">
                    <strong>{context.categories.find((c) => c.id === b.category)?.name ?? b.category}</strong>
                    <br />
                    <span class="faint">
                      {new Date(b.created).toLocaleString('en-US')} · {b.total} written · {b.approved} approved
                    </span>
                  </span>
                  <span class="pill">{b.pending} to read</span>
                </button>
              ))}
            </div>
          )}

          <div class="card stack">
            <div class="eyebrow">Packs on this machine</div>
            {context.packs.length === 0 && <p class="muted">None yet. Published packs appear here.</p>}
            {context.packs.map((p) => (
              <div key={p.id} class="row-between">
                <span>
                  <strong>{p.name}</strong>
                  <br />
                  <span class="faint">
                    {p.questionCount} questions · {p.audience} · reviewed by {p.reviewedBy ?? 'unknown'}
                  </span>
                </span>
                <span class="pill">{p.origin}</span>
              </div>
            ))}
            <p class="faint">
              Switch packs on for a night in the MC controls, under Questions. A night needs at
              least one pack for the age group it is set to.
            </p>
          </div>
        </>
      )}

      <Toast message={toast} onDismiss={() => setToast(null)} />
    </div>
  );

  async function load() {
    try {
      setContext(await api(token!)<Context>('/api/author/context'));
      setError('');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function open(id: string) {
    try {
      setBatch(await api(token!)<DraftBatch>(`/api/author/batch/${id}`));
    } catch (err) {
      setToast((err as Error).message);
    }
  }
}

render(<App />, document.getElementById('app')!);
