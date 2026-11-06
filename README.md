# RetirePlan — phased-contribution retirement calculator

A 100% client-side web app: no build step, no dependencies, no network calls,
no accounts. It answers one question:

> **How much can I spend per month in retirement — in today's dollars?**

Its distinguishing feature: **the contribution period and the retirement date
are separate clocks.** Most calculators assume you contribute every month
until the day you retire. This one models stopping early and coasting.

## Quick start

Open `index.html` in any browser (double-click works), or serve the folder:

```bash
cd retirement-calculator
python3 -m http.server 8765
# → http://127.0.0.1:8765
```

## The scenario it models

| Phase | Example | What happens |
|---|---|---|
| **Saving** | $1M now + $4,000/mo for **5 years** | Monthly contributions + growth |
| **Coasting** | Next **5 years**, retire in 10 | No contributions — compounding only |
| **Spending** | 30 years in retirement | Level, inflation-indexed withdrawals until the pot reaches ~$0 |

With those defaults (7% growth before retirement, 4.5% in retirement, 2.5%
inflation, retirement in 10 years):

| Result | Value |
|---|---|
| Pot at retirement | $2,368,833 future $ = **$1,850,529 in today's $** |
| You put in | $1,240,000 ($1M + $240,000 contributed) |
| Growth earned by retirement | $1,128,833 |
| **Sustainable spending** | **$6,768/mo ($81,217/yr) in today's dollars** |
| First retirement year actually pays | $8,664/mo (future $ — inflation has eroded the dollar) |
| Implied withdrawal rate | 4.4% of the pot at retirement |

## Inputs

| Input | Meaning |
|---|---|
| Current savings | What you have invested today |
| Target retirement year | When withdrawals start; contributions may end long before |
| Monthly contribution | Amount added at the start of each month |
| Contribute for (years) | **The unique bit.** After this, contributions stop and the pot coasts. Set equal to years-to-retirement to contribute all the way |
| Contribution increase / year | Optional annual escalation of the contribution |
| Investment growth before retirement | Expected nominal return while accumulating |
| Growth in retirement | Usually lower (more bonds/cash); drives the drawdown |
| Inflation | Used to restate everything in today's purchasing power |
| Years spent in retirement | How long the pot must last; spending is solved to end at ~$0 exactly then |
| Other income at retirement | Pension / Social Security, in today's $/mo, assumed inflation-indexed (see note below) |
| Spending you'd like | Optional check: "how long would $X/mo actually last?" plus a gap solver (below) |

Growth presets (Conservative 3% / Balanced 5% / Growth 7% / Optimistic 9%) set
both return fields at once; you can still edit them individually afterwards.

## Outputs

- **Headline sustainable spending** — level monthly amount, in today's dollars,
  that exactly funds your chosen retirement length; also shown per year and
  as the inflated amount the first retirement year actually pays.
- **Sensitivity strip** — the same answer if both growth rates were 2%/yr
  lower or higher (defaults: $4,289 / $6,768 / $10,314 per month). A plan that
  only works in the +2% column is fragile.
- **Pot at retirement** in future dollars and today's dollars, what you put
  in, what growth added, and the **inflation bite** (purchasing power lost
  while waiting to retire).
- **Balance-over-time chart** (hover for values) with a today-$ / future-$
  toggle, and a **year-by-year table** (start, contributed, growth, spent,
  end) aggregated from the monthly simulation.

### Desired-spending check, gap solver & back-fill

Enter "Spending you'd like" and the app reports how many years that level
actually lasts. If it falls short, it also computes:

- the pot (today-$) that spending level would require, and the shortfall;
- what closes the gap: **extra $/mo during your contribution phase**, or a
  **lump sum today** (only the lump sum is offered if contributions are 0).

**Back-fill** turns that advice into the plan itself. A back-fill row sits
under the field whenever a portfolio-funded desired spend is entered, with a
toggle — **Monthly contributions** / **Current savings** — choosing which
input absorbs the whole difference, and a hint previewing the exact new
value. Pressing **← Back-fill to fund this spending** writes it into that
field; every result, the chart, and persistence then update as if you'd
typed it. It works in **both directions**: raise “Spending you'd like” and
it tops the input up, lower it and it trims the input back down (floored at
$0), so you can iterate on the target freely — the button never disables or
changes label. Values are rounded up to the nearest $10 so rounding can't
reopen a gap. (If contributions have already ended, the monthly side has no
lever, so the difference lands on current savings instead — the preview
shows which field will change. If one input alone already funds more than a
lowered target even at $0, the hint says so.)

If other income alone covers your desired spending, the pot is reported as
untouched.

### Note on "Other income"

Other income **adds to total spendable income**, it does not change the pot:
headline spending = portfolio-funded spending + other income. Consequently
the pot-at-retirement, chart, and year-by-year "Spent" column (which track
*portfolio withdrawals only*) do not move when you change it — the headline
total, the "+ other income" tile, and the desired-spending check do. That is
by design: a pension is spent alongside the portfolio, not deposited into it.

## Method

- Monthly simulation; contributions and withdrawals at the **start** of each
  month, then growth for the month. Annual rates are converted to effective
  monthly rates, $r_m = (1+r)^{1/12}-1$.
- Sustainable spending is a level real (inflation-adjusted) annuity-due solved
  from the pot in today's dollars using the real retirement return
  $(1+r_{after})/(1+\text{inflation})-1$. The nominal drawdown simulation
  indexes each withdrawal by inflation from today and ends at ~$0.
- Everything is reported in **today's dollars** unless labelled "future $":
  future amounts are divided by $(1+\text{inflation})^{\text{years}}$.
- Inputs are clamped to sane ranges (returns −50%…30%, inflation −10%…30%,
  non-negative money) with an on-page warning, so extreme entries can't
  produce `NaN` results. A retirement year in the past is treated as
  "retire now"; a contribution period longer than the time to retirement is
  capped at retirement.

## Privacy & persistence

- All computation runs locally in your browser; nothing is sent anywhere.
- Inputs persist in `localStorage` on that browser only.
- **Copy share link** encodes the inputs in the URL hash (`#…`), so a plan can
  be shared by link; opening such a link restores the inputs. Works from
  `file://` too.
- A print stylesheet is included: printing shows the results without the
  input form.

## Files

| File | Purpose |
|---|---|
| `index.html` | Markup and form |
| `style.css` | Layout, responsive + print styles |
| `app.js` | Simulation, solver, chart, persistence (vanilla JS, no dependencies) |
| `README.md` | This file |

## Limitations

Constant assumed returns and inflation (no market volatility/sequence risk,
no Monte Carlo), no taxes, fees, or account types, no Social Security
claiming-age modelling, and other income is assumed to start at retirement
and keep pace with inflation. An illustration for planning — **not financial
advice.**
