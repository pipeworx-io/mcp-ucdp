# @pipeworx/ucdp

Uppsala Conflict Data Program (UCDP) — armed-conflict fatalities, active conflicts and georeferenced violence events for every country since 1989, from the published UCDP yearly datasets, the monthly GED Candidate release, and (with a token) the UCDP API.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

- `ucdp_fatalities_summary(country, year? | from?/to?)` — deaths from organized violence for a country-year: best/low/high, split state-based / non-state / one-sided, combatants vs civilians, named dyads. Answers "how many people were killed in the Sudan war in 2024".
- `ucdp_conflicts(country?, year?, intensity?)` — UCDP/PRIO armed conflicts active in a year with parties, incompatibility, type, intensity, episode dates and battle-related deaths.
- `ucdp_countries(query?, region?, min_deaths?)` — the 199 coded countries with Gleditsch-Ward codes, coverage years and latest-year deaths (sorted by deaths).
- `ucdp_recent_events(country?, type_of_violence?, min_deaths?, limit?)` — individual events from the newest monthly GED Candidate file (preliminary, current year).
- `ucdp_events(country, start?, end?, type_of_violence?, limit?, page?, version?, _apiKey)` — GED events for any date range 1989 onward via the UCDP API. **Requires an API key.**

## Auth

Keyless for the first four tools. `ucdp_events` is BYO only: pass a UCDP API access token as `_apiKey` (sent as the `x-ucdp-access-token` header). This is a standing decision, not a gap: Bruce ruled BYOK on 2026-09-03 (fleet #1226), so Pipeworx will not request a platform token, and the refusal without one says "requires an API key" and points at https://ucdp.uu.se/apidocs.

### Activation caveat

UCDP tokens are not self-service. Since 2025 every API call needs a token, and tokens are issued by emailing the API maintainer (address and template at https://ucdp.uu.se/apidocs) with a description of the intended use; requests are answered in 3–5 working days. Without a token every `ucdpapi.pcr.uu.se` call returns HTTP 401 "API token required" — that is the vendor gate, not an outage.

If that decision is ever revisited and a platform token exists: set `PLATFORM_UCDP_TOKEN` on the gateway AND add `platformKeyEnv: 'PLATFORM_UCDP_TOKEN'` to the pack's `MCP_PACKS` entry in the same deploy. Declaring `platformKeyEnv` while the secret is unset key-blocks every tool in the pack from routing, including the keyless ones.

## Data sources

- https://ucdp.uu.se/downloads/ — the downloads index. Read once per isolate to discover the newest yearly version (`organizedviolencecy-<NNN>-csv.zip`, re-released each June as vNN.1) and the newest monthly GED Candidate file (`candidateged/GEDEvent_v<major>_<minor>_<month>.csv`). Falls back to pinned v26.1 / 26.0.7 if the page cannot be read.
- https://ucdp.uu.se/downloads/organizedviolencecy/organizedviolencecy-261-csv.zip — Organized Violence Country-Year dataset (167 KB zip, 7,132 rows, 1989–2025). Backs `ucdp_fatalities_summary` and `ucdp_countries`.
- https://ucdp.uu.se/downloads/ucdpprio/ucdp-prio-acd-261-csv.zip — UCDP/PRIO Armed Conflict Dataset (1946–2025).
- https://ucdp.uu.se/downloads/brd/ucdp-brd-conf-261-csv.zip — Battle-Related Deaths, conflict level (1989–2025). Joined to ACD on `conflict_id` + `year`.
- https://ucdp.uu.se/downloads/candidateged/GEDEvent_v26_0_7.csv — monthly GED Candidate (~1.4 MB, one month of preliminary events). Quarterly files (`GEDEvent_v26_01_26_06.csv`, ~8 MB) are deliberately not fetched.
- https://ucdpapi.pcr.uu.se/api/gedevents/<version> — GED via the API. Filters: `Country=<GW code>` (multiple allowed), `StartDate`/`EndDate` (YYYY-MM-DD, match on `date_end`), `TypeOfViolence=1|2|3`, `pagesize` + `page` (1-based). Requesting a page past `TotalPages` returns a server error rather than an empty set. Result order is arbitrary.

Traps:
- The full GED zip (`ged261-csv.zip`) is 39 MB and inflates far beyond what a Worker can hold — event history before the current month needs the API.
- UCDP names states by continuity: "Russia (Soviet Union)", "Yemen (North Yemen)", "DR Congo (Zaire)", "Myanmar (Burma)". The resolver accepts the common names and aliases (DRC, USA, UK, Côte d'Ivoire, Eswatini, Czechia, Türkiye, Timor-Leste…) and Gleditsch-Ward codes; Palestine/Gaza/West Bank map to Israel because UCDP codes sovereign states only.
- `sb_dyad_names` / `ns_dyad_names` / `os_dyad_names` are `;`-separated inside one CSV field.
- All UCDP counts use a 25-deaths-per-dyad-year inclusion threshold; a country with real but diffuse violence can show zero.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ucdp": {
      "url": "https://gateway.pipeworx.io/ucdp/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ucdp/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ucdp_fatalities_summary \
  -H 'Content-Type: application/json' \
  -d '{"country":"Sudan","year":2024}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ucdp_fatalities_summary`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "ucdp": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ucdp"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-ucdp
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ucdp data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
