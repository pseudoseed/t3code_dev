# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

The **Limits** view shows how much of each subscription window you have used on Codex and Claude
Code, per connected environment: the session and weekly windows, plus a per-model weekly window
such as Fable when your plan has one. Each window is a bar from the moment it opened to its reset,
filled by the share of quota spent; a thin line marks how far into the window you are, which is
also where even spending would have put the fill, and the icon beside the label says whether you
are ahead of, on, or under that pace. Hover a bar for the exact reset time. Limits refresh on the
provider health-check interval and update live while a turn runs. API-key accounts have no
subscription windows and say so; that includes a Claude Code that reaches Anthropic through a proxy
via `ANTHROPIC_AUTH_TOKEN`, since the CLI then treats itself as an API-key client.

**Add source** on the Limits view brings in quota from outside this machine's own providers. Each
added account is marked with the source it came from, so it is not mistaken for the provider signed
in here, and emails are blurred until clicked as in provider settings.

- A **CLIProxyAPI hub** shows every account the hub pools. Enter its URL and management key; the
  key is stored on the server and never sent back to a client.
- A **usage dashboard** shows every subscription it polls, including accounts nothing on this
  machine is signed into. Enter its URL; there is no key, so point this only at a dashboard you
  trust on your own network. When the dashboard reports banked rate-limit reset credits on an
  account, the card offers to spend one. Redeeming asks first and cannot be undone.

The **Limits** button in the bottom-left corner opens the same accounts as one dial per account.
Each dial carries two rings: the inner one is the session window, which decides whether you can
start a turn right now and takes the colour of how close it is to full; the outer one is the weekly
window, which is how much of the cycle is left, and stays a steady blue because a large weekly is
not the same kind of news as a nearly-spent session. The number in the middle is the session. Every
window is also listed as a bar underneath with its exact percent and reset, and the reset-credit
control sits at the bottom of accounts that have credits banked.

The overlay opens over your current thread and dismisses without navigating away, so you can check
where a subscription stands mid-turn. Its countdowns are measured from the moment it opened and do
not tick; **Refresh** re-reads every environment and re-anchors them.

On phones and tablets the same dials are under **Settings → Limits**.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Refreshing rescans every connected environment and refetches model pricing on
each of them, so a newly released model that showed $0.00 gets a price without waiting for the daily
pricing update.
