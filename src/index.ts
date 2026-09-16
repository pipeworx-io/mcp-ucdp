interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Armed-conflict deaths, active wars and violence events from the Uppsala Conflict Data Program (UCDP), every country since 1989.
 *
 * Uppsala Conflict Data Program: yearly fatality totals by country, the
 * UCDP/PRIO armed-conflict list with battle deaths, and georeferenced events
 * (ucdp.uu.se).
 *
 * Tools:
 * - ucdp_fatalities_summary: deaths from organized violence for a country and
 *   year (or year range), split state-based / non-state / one-sided with
 *   best/low/high estimates. Keyless — read from UCDP's published yearly
 *   Organized Violence Country-Year dataset.
 * - ucdp_conflicts: active armed conflicts for a country/year from the
 *   UCDP/PRIO Armed Conflict Dataset joined to Battle-Related Deaths. Keyless.
 * - ucdp_countries: the countries UCDP codes, with Gleditsch-Ward numbers.
 * - ucdp_recent_events: individual violence events from the latest monthly
 *   UCDP GED Candidate release (current year, preliminary). Keyless.
 * - ucdp_events: individual GED events for any date range since 1989 via the
 *   UCDP API. Requires an API key (x-ucdp-access-token) — pass _apiKey.
 *
 * Data comes from two upstream surfaces:
 *   https://ucdp.uu.se/downloads/            yearly datasets + GED Candidate CSVs (no key)
 *   https://ucdpapi.pcr.uu.se/api/            paged JSON API (token required since 2025)
 */


const UA = 'pipeworx-mcp-ucdp/1.0 (+https://pipeworx.io; hello@pipeworx.io)';

async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, 'UCDP', 25_000);
}

const DOWNLOADS = 'https://ucdp.uu.se/downloads';
const API = 'https://ucdpapi.pcr.uu.se/api';

// Yearly datasets are re-released each June as vNN.1 (26.1 = June 2026). The
// downloads page is read once per isolate to discover the newest version and
// the newest GED Candidate monthly file; these are the fallbacks if that read
// fails, so a downloads-page redesign degrades to last-known rather than to
// an error.
const PINNED_YEARLY = '261';
const PINNED_CANDIDATE = `${DOWNLOADS}/candidateged/GEDEvent_v26_0_7.csv`;

type Row = Record<string, string>;

interface DownloadUrls {
  yearlyVersion: string; // e.g. "261"
  cy: string;
  acd: string;
  brd: string;
  candidateMonthly: string;
  candidateLabel: string; // e.g. "26.0.7"
}

function yearlyUrls(v: string): Pick<DownloadUrls, 'cy' | 'acd' | 'brd'> {
  return {
    cy: `${DOWNLOADS}/organizedviolencecy/organizedviolencecy-${v}-csv.zip`,
    acd: `${DOWNLOADS}/ucdpprio/ucdp-prio-acd-${v}-csv.zip`,
    brd: `${DOWNLOADS}/brd/ucdp-brd-conf-${v}-csv.zip`,
  };
}

let urlsPromise: Promise<DownloadUrls> | null = null;
function discoverUrls(): Promise<DownloadUrls> {
  if (urlsPromise) return urlsPromise;
  urlsPromise = (async () => {
    const fallback: DownloadUrls = {
      yearlyVersion: PINNED_YEARLY,
      ...yearlyUrls(PINNED_YEARLY),
      candidateMonthly: PINNED_CANDIDATE,
      candidateLabel: '26.0.7',
    };
    try {
      const res = await pwFetch(`${DOWNLOADS}/`);
      if (!res.ok) return fallback;
      const html = await res.text();
      const yearly = [...html.matchAll(/organizedviolencecy-(\d{3})-csv\.zip/g)].map((m) => m[1]);
      const yv = yearly.sort().at(-1) ?? PINNED_YEARLY;
      // Monthly candidate files are GEDEvent_v26_0_7.csv (major_minor_month);
      // quarterly ones are GEDEvent_v26_01_26_06.csv (two-part range) — the
      // 3-segment pattern picks only monthlies.
      const monthlies = [...html.matchAll(/candidateged\/GEDEvent_v(\d+)_(\d+)_(\d+)\.csv/gi)]
        .map((m) => ({ key: [m[1], m[2], m[3]].map((n) => n.padStart(3, '0')).join('.'), label: `${m[1]}.${m[2]}.${m[3]}`, url: `${DOWNLOADS}/candidateged/${m[0].slice('candidateged/'.length)}` }))
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const latest = monthlies.at(-1);
      return {
        yearlyVersion: yv,
        ...yearlyUrls(yv),
        candidateMonthly: latest?.url ?? PINNED_CANDIDATE,
        candidateLabel: latest?.label ?? '26.0.7',
      };
    } catch {
      return fallback;
    }
  })();
  // A failed discovery must not be memoised as the answer forever.
  urlsPromise.catch(() => { urlsPromise = null; });
  return urlsPromise;
}

// ---------- CSV + ZIP ----------

function parseCsv(text: string): Row[] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() ?? [];
  return rows.map((r) => {
    const o: Row = {};
    for (let i = 0; i < head.length; i++) o[head[i].trim()] = (r[i] ?? '').trim();
    return o;
  });
}

const MAX_MEMBER = 64 * 1024 * 1024;

/** Extract the first .csv member of a small ZIP (stored or deflated). */
async function firstCsvFromZip(bytes: Uint8Array): Promise<string> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i >= bytes.length - 65_558; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('upstream_error: UCDP download is not a ZIP archive');
  const total = dv.getUint16(eocd + 10, true);
  let offset = dv.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let i = 0; i < total; i++) {
    if (offset + 46 > bytes.length || dv.getUint32(offset, true) !== 0x02014b50) break;
    const method = dv.getUint16(offset + 10, true);
    const compressedSize = dv.getUint32(offset + 20, true);
    const uncompressedSize = dv.getUint32(offset + 24, true);
    const nameLength = dv.getUint16(offset + 28, true);
    const extraLength = dv.getUint16(offset + 30, true);
    const commentLength = dv.getUint16(offset + 32, true);
    const localOffset = dv.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)).toLowerCase();
    offset += 46 + nameLength + extraLength + commentLength;
    if (!name.endsWith('.csv')) continue;
    if (uncompressedSize > MAX_MEMBER) throw new Error('upstream_error: UCDP CSV member exceeds size limit');
    if (localOffset + 30 > bytes.length || dv.getUint32(localOffset, true) !== 0x04034b50) continue;
    const localNameLength = dv.getUint16(localOffset + 26, true);
    const localExtraLength = dv.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const payload = bytes.subarray(start, start + compressedSize);
    if (method === 0) return decoder.decode(payload);
    if (method === 8) {
      const src = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(payload); c.close(); } });
      return await new Response(src.pipeThrough(new DecompressionStream('deflate-raw'))).text();
    }
    throw new Error(`upstream_error: unsupported ZIP compression method ${method}`);
  }
  throw new Error('upstream_error: no CSV member in UCDP download');
}

// Parsed datasets are memoised per isolate for a few hours: the yearly files
// change once a year and the candidate file once a month.
const MEMO_TTL_MS = 6 * 3600 * 1000;
const memo = new Map<string, { at: number; rows: Promise<Row[]> }>();

function loadRows(url: string, zipped: boolean): Promise<Row[]> {
  const hit = memo.get(url);
  if (hit && Date.now() - hit.at < MEMO_TTL_MS) return hit.rows;
  const rows = (async () => {
    const res = await pwFetch(url);
    if (!res.ok) throw new Error(`upstream_error: UCDP download returned HTTP ${res.status}`);
    const text = zipped ? await firstCsvFromZip(new Uint8Array(await res.arrayBuffer())) : await res.text();
    return parseCsv(text);
  })();
  memo.set(url, { at: Date.now(), rows });
  rows.catch(() => memo.delete(url));
  return rows;
}

async function countryYear(): Promise<Row[]> { return loadRows((await discoverUrls()).cy, true); }
async function armedConflicts(): Promise<Row[]> { return loadRows((await discoverUrls()).acd, true); }
async function battleDeaths(): Promise<Row[]> { return loadRows((await discoverUrls()).brd, true); }
async function candidateEvents(): Promise<Row[]> { return loadRows((await discoverUrls()).candidateMonthly, false); }

// ---------- country resolution ----------

function norm(s: string): string {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Names agents actually type → the name UCDP uses. UCDP labels a state by its
// historical continuity ("Russia (Soviet Union)", "Yemen (North Yemen)").
const ALIASES: Record<string, string> = {
  drc: 'DR Congo (Zaire)', 'dr congo': 'DR Congo (Zaire)', 'congo kinshasa': 'DR Congo (Zaire)',
  'democratic republic of the congo': 'DR Congo (Zaire)', 'democratic republic of congo': 'DR Congo (Zaire)',
  'congo dr': 'DR Congo (Zaire)', 'congo democratic republic': 'DR Congo (Zaire)', zaire: 'DR Congo (Zaire)',
  'republic of the congo': 'Congo', 'republic of congo': 'Congo', 'congo brazzaville': 'Congo',
  usa: 'United States of America', us: 'United States of America', 'united states': 'United States of America', america: 'United States of America',
  uk: 'United Kingdom', britain: 'United Kingdom', 'great britain': 'United Kingdom', england: 'United Kingdom',
  'cote d ivoire': 'Ivory Coast', 'cote divoire': 'Ivory Coast',
  eswatini: 'Kingdom of eSwatini (Swaziland)', swaziland: 'Kingdom of eSwatini (Swaziland)',
  czechia: 'Czech Republic', turkiye: 'Turkey', 'timor leste': 'East Timor', burma: 'Myanmar (Burma)', myanmar: 'Myanmar (Burma)',
  russia: 'Russia (Soviet Union)', 'russian federation': 'Russia (Soviet Union)', ussr: 'Russia (Soviet Union)', 'soviet union': 'Russia (Soviet Union)',
  serbia: 'Serbia (Yugoslavia)', yugoslavia: 'Serbia (Yugoslavia)',
  bosnia: 'Bosnia-Herzegovina', 'bosnia and herzegovina': 'Bosnia-Herzegovina',
  macedonia: 'North Macedonia', vietnam: 'Vietnam (North Vietnam)', 'viet nam': 'Vietnam (North Vietnam)',
  yemen: 'Yemen (North Yemen)', cambodia: 'Cambodia (Kampuchea)', madagascar: 'Madagascar (Malagasy)',
  zimbabwe: 'Zimbabwe (Rhodesia)', rhodesia: 'Zimbabwe (Rhodesia)', samoa: 'Samoa (Western Samoa)',
  car: 'Central African Republic', uae: 'United Arab Emirates', 'holy see': 'Vatican City State', vatican: 'Vatican City State',
  'cabo verde': 'Cape Verde', 'east germany': 'German Democratic Republic', micronesia: 'Federated States of Micronesia',
  'korea south': 'South Korea', 'republic of korea': 'South Korea', 'korea north': 'North Korea', dprk: 'North Korea',
  laos: 'Laos', 'lao pdr': 'Laos', persia: 'Iran', 'the gambia': 'Gambia', 'the bahamas': 'Bahamas',
  'trinidad': 'Trinidad and Tobago', 'st kitts and nevis': 'Saint Kitts and Nevis', 'st lucia': 'Saint Lucia',
  'st vincent and the grenadines': 'Saint Vincent and the Grenadines', 'sao tome': 'Sao Tome and Principe',
  'south sudan': 'South Sudan', sudan: 'Sudan', palestine: 'Israel', gaza: 'Israel', 'west bank': 'Israel',
};

interface CountryRef { country: string; gw_code: number; region: string }

let countryIndexPromise: Promise<CountryRef[]> | null = null;
function countryIndex(): Promise<CountryRef[]> {
  if (countryIndexPromise) return countryIndexPromise;
  countryIndexPromise = countryYear().then((rows) => {
    const seen = new Map<string, CountryRef>();
    for (const r of rows) {
      if (!seen.has(r.country)) seen.set(r.country, { country: r.country, gw_code: Number(r.country_id), region: r.region });
    }
    return [...seen.values()].sort((a, b) => a.country.localeCompare(b.country));
  });
  countryIndexPromise.catch(() => { countryIndexPromise = null; });
  return countryIndexPromise;
}

function baseName(name: string): string { return name.replace(/\s*\(.*\)\s*$/, ''); }
function parenName(name: string): string | null { const m = name.match(/\(([^)]+)\)\s*$/); return m ? m[1] : null; }

async function resolveCountry(input: unknown): Promise<{ ref: CountryRef } | { found: false; reason: string; message: string; hint: string; suggestions: string[] }> {
  const raw = String(input ?? '').trim();
  if (!raw) return { found: false, reason: 'empty_query', message: 'country is required', hint: 'Pass a country name ("Sudan") or its Gleditsch-Ward code (625). ucdp_countries lists both.', suggestions: [] };
  const idx = await countryIndex();
  if (/^\d{1,3}$/.test(raw)) {
    const byCode = idx.find((c) => c.gw_code === Number(raw));
    if (byCode) return { ref: byCode };
  }
  const q = norm(raw);
  const aliased = ALIASES[q];
  if (aliased) { const hit = idx.find((c) => c.country === aliased); if (hit) return { ref: hit }; }
  const exact = idx.find((c) => norm(c.country) === q);
  if (exact) return { ref: exact };
  const partial = idx.find((c) => norm(baseName(c.country)) === q || (parenName(c.country) && norm(parenName(c.country)!) === q));
  if (partial) return { ref: partial };
  const prefix = idx.filter((c) => norm(c.country).startsWith(q));
  if (prefix.length === 1) return { ref: prefix[0] };
  const contains = idx.filter((c) => norm(c.country).includes(q) || q.includes(norm(baseName(c.country))));
  if (contains.length === 1) return { ref: contains[0] };
  const suggestions = [...new Set([...prefix, ...contains].map((c) => c.country))].slice(0, 8);
  return {
    found: false,
    reason: 'no_match',
    message: `No UCDP country matches "${raw}"`,
    hint: suggestions.length ? `Did you mean: ${suggestions.join(', ')}? UCDP names states by continuity, e.g. "Russia (Soviet Union)". ucdp_countries lists all 199.` : 'UCDP codes sovereign states only (no territories). Call ucdp_countries to see the list and Gleditsch-Ward codes.',
    suggestions,
  };
}

// ---------- shaping ----------

const num = (v: string | undefined): number | null => (v === undefined || v === '' ? null : Number(v));
const flag = (v: string | undefined): boolean => v === '1' || v === 'true';

const VIOLENCE_TYPE: Record<string, string> = { '1': 'state-based', '2': 'non-state', '3': 'one-sided' };
const CONFLICT_TYPE: Record<string, string> = { '1': 'extrasystemic', '2': 'interstate', '3': 'intrastate', '4': 'internationalized intrastate' };
const INCOMPATIBILITY: Record<string, string> = { '1': 'territory', '2': 'government', '3': 'territory and government' };
const INTENSITY: Record<string, string> = { '1': 'minor (25-999 battle deaths)', '2': 'war (1,000+ battle deaths)' };
const ACD_REGION: Record<string, string> = { '1': 'Europe', '2': 'Middle East', '3': 'Asia', '4': 'Africa', '5': 'Americas' };

function estimate(r: Row, prefix: string) {
  return { best: num(r[`${prefix}_best`]), low: num(r[`${prefix}_low`]), high: num(r[`${prefix}_high`]) };
}

function splitIds(v: string | undefined): string[] { return (v ?? '').split(/[;,]\s*/).map((s) => s.trim()).filter(Boolean); }

function shapeCountryYear(r: Row) {
  return {
    year: Number(r.year),
    total_deaths: {
      best: num(r.cumulative_total_deaths_in_orgvio_best),
      low: num(r.cumulative_total_deaths_in_orgvio_low),
      high: num(r.cumulative_total_deaths_in_orgvio_high),
    },
    deaths_by_victim: {
      combatants: num(r.cumulative_total_deaths_parties_in_orgvio),
      civilians: num(r.cumulative_total_deaths_civilians_in_orgvio),
      unknown: num(r.cumulative_total_deaths_unknown_in_orgvio),
    },
    by_type: {
      state_based: {
        active: flag(r.sb_exist),
        dyads: num(r.sb_dyad_count),
        dyad_names: splitIds(r.sb_dyad_names),
        deaths: estimate(r, 'sb_total_deaths'),
        deaths_combatants: num(r.sb_deaths_parties),
        deaths_civilians: num(r.sb_deaths_civilians),
        intrastate_deaths: estimate(r, 'sb_intrastate_deaths'),
        interstate_deaths: estimate(r, 'sb_interstate_deaths'),
      },
      non_state: {
        active: flag(r.ns_exist),
        dyads: num(r.ns_dyad_count),
        dyad_names: splitIds(r.ns_dyad_names),
        deaths: estimate(r, 'ns_total_deaths'),
      },
      one_sided: {
        active: flag(r.os_exist),
        actors: num(r.os_dyad_count),
        actor_names: splitIds(r.os_dyad_names),
        deaths: estimate(r, 'os_total_deaths'),
        killings_by_government: estimate(r, 'os_govt_killings'),
        killings_by_non_state_groups: estimate(r, 'os_nsgroup_killings'),
      },
    },
  };
}

// Candidate CSV dates arrive as "2026-07-31 00:00:00.000"; keep the date part.
const day = (v: string | undefined): string | null => (v ? v.slice(0, 10) : null);

function shapeCandidateEvent(r: Row) {
  return {
    id: num(r.id),
    date_start: day(r.date_start),
    date_end: day(r.date_end),
    country: r.country,
    gw_code: num(r.country_id),
    region: r.region,
    admin1: r.adm_1 || null,
    admin2: r.adm_2 || null,
    location: r.where_description || r.where_coordinates || null,
    latitude: num(r.latitude),
    longitude: num(r.longitude),
    type_of_violence: VIOLENCE_TYPE[r.type_of_violence] ?? r.type_of_violence,
    conflict: r.conflict_name,
    dyad: r.dyad_name,
    side_a: r.side_a,
    side_b: r.side_b,
    deaths: { best: num(r.best), low: num(r.low), high: num(r.high), side_a: num(r.deaths_a), side_b: num(r.deaths_b), civilians: num(r.deaths_civilians), unknown: num(r.deaths_unknown) },
    source: { headline: r.source_headline || null, office: r.source_office || null, date: day(r.source_date), count: num(r.number_of_sources) },
    code_status: r.code_status,
    precision: { date: num(r.date_prec), location: num(r.where_prec), clarity: num(r.event_clarity) },
  };
}

function shapeApiEvent(e: Record<string, unknown>) {
  const n = (k: string) => (typeof e[k] === 'number' ? (e[k] as number) : e[k] == null ? null : Number(e[k]));
  const s = (k: string) => (e[k] == null ? null : String(e[k]));
  return {
    id: n('id'),
    date_start: s('date_start'),
    date_end: s('date_end'),
    country: s('country'),
    gw_code: n('country_id'),
    region: s('region'),
    admin1: s('adm_1'),
    admin2: s('adm_2'),
    location: s('where_description') ?? s('where_coordinates'),
    latitude: n('latitude'),
    longitude: n('longitude'),
    type_of_violence: VIOLENCE_TYPE[String(e.type_of_violence)] ?? s('type_of_violence'),
    conflict: s('conflict_name'),
    dyad: s('dyad_name'),
    side_a: s('side_a'),
    side_b: s('side_b'),
    deaths: { best: n('best'), low: n('low'), high: n('high'), side_a: n('deaths_a'), side_b: n('deaths_b'), civilians: n('deaths_civilians'), unknown: n('deaths_unknown') },
    source: { headline: s('source_headline'), office: s('source_office'), date: s('source_date'), article: s('source_article'), count: n('number_of_sources') },
    code_status: s('code_status'),
    precision: { date: n('date_prec'), location: n('where_prec'), clarity: n('event_clarity') },
  };
}

function parseViolenceType(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  const s = norm(String(v));
  if (['1', 'state based', 'state', 'sb'].includes(s)) return '1';
  if (['2', 'non state', 'nonstate', 'ns'].includes(s)) return '2';
  if (['3', 'one sided', 'onesided', 'os', 'civilians', 'against civilians'].includes(s)) return '3';
  throw new Error(`user_error: type_of_violence must be state-based (1), non-state (2) or one-sided (3); got "${String(v)}"`);
}

function clampInt(v: unknown, dflt: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return dflt;
  return Math.min(Math.floor(n), max);
}

const YEAR_RE = /^\d{4}$/;
function optYear(v: unknown, name: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!YEAR_RE.test(s)) throw new Error(`user_error: ${name} must be a four-digit year, got "${s}"`);
  return Number(s);
}

const versionLabel = (v: string) => `${v.slice(0, 2)}.${v.slice(2)}`;

// ---------- tools ----------

const tools: McpToolExport['tools'] = [
  {
    name: 'ucdp_fatalities_summary',
    description:
      'Deaths from armed conflict and organized violence in a country for a year or range of years, from the Uppsala Conflict Data Program (UCDP) country-year dataset: best, low and high fatality estimates split into state-based conflict, non-state conflict and one-sided violence against civilians, plus combatant vs civilian victims and the named warring dyads. Answers "how many people were killed in the Sudan war in 2024", conflict death tolls, casualty trends since 1989. Country names resolve to Gleditsch-Ward codes. Example: ucdp_fatalities_summary({ country: "Sudan", year: 2024 })',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country name ("Sudan", "DR Congo", "Myanmar") or Gleditsch-Ward code ("625")' },
        year: { type: 'integer', description: 'Calendar year, 1989 to the latest released year. Omit for the latest year.' },
        from: { type: 'integer', description: 'Start year of a range (with `to`) — returns one row per year' },
        to: { type: 'integer', description: 'End year of a range (with `from`)' },
      },
      required: ['country'],
    },
  },
  {
    name: 'ucdp_conflicts',
    description:
      'Armed conflicts recorded by UCDP/PRIO for a country or year: the government and rebel/state parties, whether the fight is over territory or government, intrastate / interstate / internationalized type, intensity (minor vs war), episode start and end dates, and battle-related deaths (best/low/high) for that year. Answers "which armed conflicts were active in Ethiopia in 2023", "how many battle deaths did the Russia-Ukraine war cause in 2024", "list wars with over 1,000 deaths". Example: ucdp_conflicts({ country: "Ethiopia", year: 2023 })',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country name or Gleditsch-Ward code of the conflict location. Omit for all countries.' },
        year: { type: 'integer', description: 'Conflict-year, 1946 onward (battle deaths from 1989). Omit for the latest year.' },
        intensity: { type: 'string', enum: ['minor', 'war'], description: 'Filter by intensity: minor (25-999 battle deaths) or war (1,000+)' },
        limit: { type: 'integer', description: 'Max conflicts to return (default 50, max 500), sorted by battle deaths' },
      },
    },
  },
  {
    name: 'ucdp_countries',
    description:
      'The countries the Uppsala Conflict Data Program codes, with their Gleditsch-Ward country codes, region, years covered and the latest year\'s total deaths from organized violence. Use it to resolve a country name or code before calling other ucdp tools, or to rank countries by conflict deaths. Example: ucdp_countries({ query: "congo" })',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring of the country name; omit for the full list' },
        region: { type: 'string', description: 'Filter by UCDP region: Africa, Americas, Asia, Europe, Middle East' },
        min_deaths: { type: 'integer', description: 'Only countries with at least this many organized-violence deaths (best estimate) in the latest year' },
      },
    },
  },
  {
    name: 'ucdp_recent_events',
    description:
      'Individual violence events from the newest monthly UCDP GED Candidate release — the preliminary current-year event list, published monthly: date, place with coordinates, warring sides, type (state-based, non-state, one-sided), fatality best/low/high and the source headline. Answers "what attacks happened in Nigeria last month", "recent conflict events in Myanmar with fatalities". For yearly totals use ucdp_fatalities_summary; for events in earlier years use ucdp_events. Example: ucdp_recent_events({ country: "Nigeria", limit: 20 })',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country name or Gleditsch-Ward code; omit for all countries' },
        type_of_violence: { type: 'string', description: 'state-based | non-state | one-sided (or 1 | 2 | 3)' },
        min_deaths: { type: 'integer', description: 'Only events with at least this many deaths (best estimate)' },
        limit: { type: 'integer', description: 'Max events (default 50, max 500), newest first' },
      },
    },
  },
  {
    name: 'ucdp_events',
    description:
      'Georeferenced armed-conflict events from the UCDP Georeferenced Event Dataset (GED) for a country and date range, 1989 to the latest yearly release: each event with date, location and coordinates, sides, violence type and best/low/high deaths. Answers "list the deadliest events in Sudan in 2024" or "battles in Donetsk in March 2023". Requires a UCDP API access token passed as _apiKey. Example: ucdp_events({ country: "Sudan", start: "2024-01-01", end: "2024-12-31", limit: 100, _apiKey: "your-token" })',
    inputSchema: {
      type: 'object',
      properties: {
        country: { type: 'string', description: 'Country name or Gleditsch-Ward code' },
        start: { type: 'string', description: 'Earliest event end date, YYYY-MM-DD' },
        end: { type: 'string', description: 'Latest event end date, YYYY-MM-DD' },
        type_of_violence: { type: 'string', description: 'state-based | non-state | one-sided (or 1 | 2 | 3)' },
        limit: { type: 'integer', description: 'Events per page (default 100, max 1000)' },
        page: { type: 'integer', description: 'Page number, 1-based' },
        version: { type: 'string', description: 'GED release, default "26.1"; candidate releases like "26.0.7" work too' },
        _apiKey: { type: 'string', description: 'UCDP API access token (x-ucdp-access-token). Request one free from the API maintainer at https://ucdp.uu.se/apidocs' },
      },
      required: ['country', '_apiKey'],
    },
  },
];

async function fatalitiesSummary(args: Record<string, unknown>) {
  const resolved = await resolveCountry(args.country);
  if (!('ref' in resolved)) return resolved;
  const { ref } = resolved;
  const [rows, urls] = await Promise.all([countryYear(), discoverUrls()]);
  const mine = rows.filter((r) => r.country === ref.country).sort((a, b) => Number(a.year) - Number(b.year));
  const first = Number(mine[0]?.year), last = Number(mine.at(-1)?.year);
  const source = `UCDP Organized Violence Country-Year Dataset v${versionLabel(urls.yearlyVersion)}`;
  const year = optYear(args.year, 'year');
  const from = optYear(args.from, 'from');
  const to = optYear(args.to, 'to');
  let selected: Row[];
  let requested: string;
  if (from !== null || to !== null) {
    const lo = from ?? first, hi = to ?? last;
    selected = mine.filter((r) => Number(r.year) >= lo && Number(r.year) <= hi);
    requested = `${lo}-${hi}`;
  } else {
    const y = year ?? last;
    selected = mine.filter((r) => Number(r.year) === y);
    requested = String(y);
  }
  if (!selected.length) {
    const asked = year ?? to ?? from;
    const beyond = asked !== null && asked > last;
    return {
      found: false,
      reason: beyond ? 'year_not_covered' : 'no_data',
      country: ref.country,
      gw_code: ref.gw_code,
      requested,
      coverage: { first_year: first, last_year: last },
      message: beyond
        ? `UCDP's yearly dataset currently ends at ${last}; ${asked} is not yet released`
        : `No UCDP country-year row for ${ref.country} in ${requested}`,
      hint: beyond
        ? 'For the current year call ucdp_recent_events (monthly GED Candidate data, preliminary) or ucdp_events with an API key and a candidate release version.'
        : `Coverage runs ${first}-${last}. Omit year for the latest.`,
      source,
    };
  }
  const data = selected.map(shapeCountryYear);
  return {
    found: true,
    country: ref.country,
    gw_code: ref.gw_code,
    region: ref.region,
    requested,
    coverage: { first_year: first, last_year: last },
    count: data.length,
    data,
    definitions: {
      state_based: 'armed conflict where at least one party is a government',
      non_state: 'fighting between organized groups, neither a government',
      one_sided: 'deliberate killing of civilians by a government or organized group',
      estimates: 'best = UCDP most reliable count; low/high = bounds across sources. All require 25+ deaths per dyad-year to be coded.',
    },
    source,
    source_url: urls.cy,
  };
}

async function conflicts(args: Record<string, unknown>) {
  let ref: CountryRef | null = null;
  if (args.country !== undefined && args.country !== null && String(args.country).trim() !== '') {
    const resolved = await resolveCountry(args.country);
    if (!('ref' in resolved)) return resolved;
    ref = resolved.ref;
  }
  const [acd, brd, urls] = await Promise.all([armedConflicts(), battleDeaths(), discoverUrls()]);
  const latest = Math.max(...acd.map((r) => Number(r.year)));
  const year = optYear(args.year, 'year') ?? latest;
  const intensity = args.intensity ? String(args.intensity).toLowerCase() : null;
  if (intensity && intensity !== 'minor' && intensity !== 'war') throw new Error('user_error: intensity must be "minor" or "war"');
  const bdIndex = new Map<string, Row>();
  for (const r of brd) bdIndex.set(`${r.conflict_id}:${r.year}`, r);
  const limit = clampInt(args.limit, 50, 500);
  let rows = acd.filter((r) => Number(r.year) === year);
  if (ref) rows = rows.filter((r) => splitIds(r.gwno_loc).includes(String(ref!.gw_code)) || splitIds(r.location).some((l) => l === ref!.country));
  if (intensity) rows = rows.filter((r) => r.intensity_level === (intensity === 'war' ? '2' : '1'));
  const shaped = rows.map((r) => {
    const bd = bdIndex.get(`${r.conflict_id}:${r.year}`);
    return {
      conflict_id: Number(r.conflict_id),
      location: splitIds(r.location),
      side_a: r.side_a,
      side_a_supporters: splitIds(r.side_a_2nd),
      side_b: r.side_b,
      side_b_supporters: splitIds(r.side_b_2nd),
      incompatibility: INCOMPATIBILITY[r.incompatibility] ?? r.incompatibility,
      territory: r.territory_name || null,
      type: CONFLICT_TYPE[r.type_of_conflict] ?? r.type_of_conflict,
      intensity: INTENSITY[r.intensity_level] ?? r.intensity_level,
      ever_reached_war: r.cumulative_intensity === '1',
      region: splitIds(r.region).map((c) => ACD_REGION[c] ?? c),
      first_activity: r.start_date || null,
      episode_start: r.start_date2 || null,
      episode_ended_this_year: r.ep_end === '1',
      episode_end_date: r.ep_end_date || null,
      battle_deaths: bd ? { best: num(bd.bd_best), low: num(bd.bd_low), high: num(bd.bd_high) } : null,
      year,
    };
  }).sort((a, b) => (b.battle_deaths?.best ?? -1) - (a.battle_deaths?.best ?? -1));
  if (!shaped.length) {
    return {
      found: false,
      reason: 'no_data',
      year,
      country: ref?.country ?? null,
      message: `No UCDP/PRIO armed conflict recorded${ref ? ` in ${ref.country}` : ''} for ${year}${intensity ? ` at ${intensity} intensity` : ''}`,
      hint: year > latest ? `The yearly dataset ends at ${latest}; try ucdp_recent_events for the current year.` : 'A conflict is coded only when a dyad causes 25+ battle deaths in the year. ucdp_fatalities_summary also covers non-state and one-sided violence.',
      coverage: { last_year: latest },
    };
  }
  return {
    found: true,
    year,
    country: ref?.country ?? null,
    gw_code: ref?.gw_code ?? null,
    count: Math.min(shaped.length, limit),
    total_matching: shaped.length,
    conflicts: shaped.slice(0, limit),
    source: `UCDP/PRIO Armed Conflict Dataset v${versionLabel(urls.yearlyVersion)} joined to UCDP Battle-Related Deaths Dataset v${versionLabel(urls.yearlyVersion)}`,
    source_urls: [urls.acd, urls.brd],
  };
}

async function countries(args: Record<string, unknown>) {
  const [idx, rows, urls] = await Promise.all([countryIndex(), countryYear(), discoverUrls()]);
  const latest = Math.max(...rows.map((r) => Number(r.year)));
  const latestByCountry = new Map<string, Row>();
  const yearsByCountry = new Map<string, number[]>();
  for (const r of rows) {
    const ys = yearsByCountry.get(r.country) ?? [];
    ys.push(Number(r.year));
    yearsByCountry.set(r.country, ys);
    if (Number(r.year) === latest) latestByCountry.set(r.country, r);
  }
  const q = args.query ? norm(String(args.query)) : null;
  const region = args.region ? norm(String(args.region)) : null;
  const minDeaths = args.min_deaths !== undefined && args.min_deaths !== null ? Number(args.min_deaths) : null;
  const out = idx
    .map((c) => {
      const ys = yearsByCountry.get(c.country) ?? [];
      const l = latestByCountry.get(c.country);
      return {
        country: c.country,
        gw_code: c.gw_code,
        region: c.region,
        first_year: Math.min(...ys),
        last_year: Math.max(...ys),
        latest_year_deaths: l ? { year: latest, ...estimate(l, 'cumulative_total_deaths_in_orgvio') } : null,
      };
    })
    .filter((c) => !q || norm(c.country).includes(q) || (ALIASES[q] === c.country))
    .filter((c) => !region || norm(c.region) === region)
    .filter((c) => minDeaths === null || (c.latest_year_deaths?.best ?? 0) >= minDeaths)
    .sort((a, b) => (b.latest_year_deaths?.best ?? 0) - (a.latest_year_deaths?.best ?? 0) || a.country.localeCompare(b.country));
  if (!out.length) return { found: false, reason: 'no_match', message: `No UCDP country matches ${JSON.stringify({ query: args.query ?? null, region: args.region ?? null, min_deaths: minDeaths })}`, hint: 'Regions are Africa, Americas, Asia, Europe, Middle East. Omit filters for all 199 countries.' };
  return { found: true, count: out.length, latest_year: latest, countries: out, source: `UCDP Organized Violence Country-Year Dataset v${versionLabel(urls.yearlyVersion)}`, source_url: urls.cy };
}

async function recentEvents(args: Record<string, unknown>) {
  let ref: CountryRef | null = null;
  if (args.country !== undefined && args.country !== null && String(args.country).trim() !== '') {
    const resolved = await resolveCountry(args.country);
    if (!('ref' in resolved)) return resolved;
    ref = resolved.ref;
  }
  const tov = parseViolenceType(args.type_of_violence);
  const minDeaths = args.min_deaths !== undefined && args.min_deaths !== null ? Number(args.min_deaths) : null;
  const limit = clampInt(args.limit, 50, 500);
  const [rows, urls] = await Promise.all([candidateEvents(), discoverUrls()]);
  let sel = rows;
  if (ref) sel = sel.filter((r) => r.country_id === String(ref!.gw_code));
  if (tov) sel = sel.filter((r) => r.type_of_violence === tov);
  if (minDeaths !== null) sel = sel.filter((r) => Number(r.best) >= minDeaths);
  sel = sel.sort((a, b) => (a.date_start < b.date_start ? 1 : a.date_start > b.date_start ? -1 : Number(b.best) - Number(a.best)));
  const dates = rows.map((r) => r.date_start).filter(Boolean).sort();
  const release = { version: urls.candidateLabel, first_event: day(dates[0]), last_event: day(dates.at(-1)), events_in_release: rows.length };
  if (!sel.length) {
    return {
      found: false,
      reason: 'no_data',
      country: ref?.country ?? null,
      release,
      message: `No events${ref ? ` in ${ref.country}` : ''}${tov ? ` of type ${VIOLENCE_TYPE[tov]}` : ''} in GED Candidate release ${urls.candidateLabel}`,
      hint: `The monthly candidate file covers preliminary events dated ${day(dates[0])} to ${day(dates.at(-1))}. For yearly totals call ucdp_fatalities_summary; for a longer event history call ucdp_events with an API key.`,
    };
  }
  const shaped = sel.slice(0, limit).map(shapeCandidateEvent);
  const totalBest = sel.reduce((s, r) => s + (Number(r.best) || 0), 0);
  return {
    found: true,
    country: ref?.country ?? null,
    gw_code: ref?.gw_code ?? null,
    release,
    count: shaped.length,
    total_matching: sel.length,
    total_deaths_best_in_matching: totalBest,
    events: shaped,
    note: 'GED Candidate data is preliminary: events are coded from the UCDP live pipeline and revised in the yearly release.',
    source: `UCDP GED Candidate monthly release ${urls.candidateLabel}`,
    source_url: urls.candidateMonthly,
  };
}

async function events(args: Record<string, unknown>) {
  const token = typeof args._apiKey === 'string' ? args._apiKey.trim() : '';
  if (!token) {
    return {
      found: false,
      reason: 'auth_required',
      message: 'UCDP requires an API key: pass your UCDP API access token as _apiKey. Request one free from the API maintainer at https://ucdp.uu.se/apidocs (reviewed in 3-5 working days).',
      hint: 'Yearly fatality totals need no key — call ucdp_fatalities_summary. The latest month of events needs no key — call ucdp_recent_events.',
    };
  }
  const resolved = await resolveCountry(args.country);
  if (!('ref' in resolved)) return resolved;
  const { ref } = resolved;
  const version = args.version ? String(args.version).trim() : '26.1';
  if (!/^\d{2}(\.\d{1,2}){1,3}$/.test(version)) throw new Error(`user_error: version must look like "26.1" or "26.0.7", got "${version}"`);
  const dateRe = /^\d{4}-\d{2}-\d{2}$/;
  for (const k of ['start', 'end'] as const) {
    if (args[k] !== undefined && args[k] !== null && !dateRe.test(String(args[k]))) throw new Error(`user_error: ${k} must be YYYY-MM-DD, got "${String(args[k])}"`);
  }
  const tov = parseViolenceType(args.type_of_violence);
  const pagesize = clampInt(args.limit, 100, 1000);
  const page = clampInt(args.page, 1, 100_000);
  const url = new URL(`${API}/gedevents/${version}`);
  url.searchParams.set('pagesize', String(pagesize));
  url.searchParams.set('page', String(page));
  url.searchParams.set('Country', String(ref.gw_code));
  if (args.start) url.searchParams.set('StartDate', String(args.start));
  if (args.end) url.searchParams.set('EndDate', String(args.end));
  if (tov) url.searchParams.set('TypeOfViolence', tov);
  const res = await pwFetch(url, { headers: { 'x-ucdp-access-token': token, Accept: 'application/json' } });
  if (res.status === 401 || res.status === 403) {
    return { found: false, reason: 'auth_failed', message: `UCDP rejected the API key (HTTP ${res.status}). UCDP requires an API key issued by its maintainer; check the token passed as _apiKey.`, hint: 'Keyless alternatives: ucdp_fatalities_summary (yearly totals) and ucdp_recent_events (latest month).' };
  }
  if (res.status === 404) {
    return { found: false, reason: 'not_found', message: `UCDP has no GED release "${version}"`, hint: 'Use the latest yearly release "26.1" or a candidate release such as "26.0.7".' };
  }
  if (!res.ok) throw new Error(`upstream_error: UCDP API returned HTTP ${res.status}`);
  const body = (await res.json()) as { TotalCount?: number; TotalPages?: number; Result?: Record<string, unknown>[] };
  const list = Array.isArray(body.Result) ? body.Result : [];
  if (!list.length) {
    return { found: false, reason: 'no_data', country: ref.country, gw_code: ref.gw_code, version, message: `No GED events in ${ref.country} for the requested filters in release ${version}`, hint: 'Widen the date range, drop type_of_violence, or use a candidate release version for the current year.' };
  }
  return {
    found: true,
    country: ref.country,
    gw_code: ref.gw_code,
    version,
    page,
    total_pages: body.TotalPages ?? null,
    total_events: body.TotalCount ?? null,
    count: list.length,
    events: list.map(shapeApiEvent),
    source: `UCDP Georeferenced Event Dataset (GED) ${version} via the UCDP API`,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'ucdp_fatalities_summary': return fatalitiesSummary(args ?? {});
    case 'ucdp_conflicts': return conflicts(args ?? {});
    case 'ucdp_countries': return countries(args ?? {});
    case 'ucdp_recent_events': return recentEvents(args ?? {});
    case 'ucdp_events': return events(args ?? {});
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
