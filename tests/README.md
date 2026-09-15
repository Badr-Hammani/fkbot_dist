# Weekend Wallet — tests

The app has no build step and no dependencies. **Only these tests do.**

They live outside `weekend-wallet/` on purpose: that folder is uploaded verbatim
to GitHub Pages, so anything inside it ships to users. Nothing here is loaded by
`index.html`, and deleting this folder would not change the app.

## Running them

```sh
cd tests
npm run setup      # once: installs playwright + a chromium build
npm test           # all suites
npm test -- money  # only suites whose filename contains "money"
```

The runner exits non-zero if anything fails, so it can gate a commit or CI.

If chromium is already on the machine, point at it instead of downloading one:

```sh
PW_CHROMIUM=/path/to/chromium node run.js
```

## How they work

Each suite boots the **real `index.html`** in a mobile-sized browser, seeds
`localStorage` with a state object, freezes the clock, then drives the UI and
reads back what a user would actually see. There are no mocks and no stubs of
the app's own logic — if a number is wrong on screen, a test fails.

`suites/scan.test.js` is the exception: `scan.js` is pure, so it is tested
directly in Node with no browser at all.

## The suites

| Suite | Guards |
|---|---|
| `scan` | Receipt parsing — amounts in both separator conventions, dates, categories |
| `money` | The budget engine, month aggregation, and every date boundary it depends on |
| `ledger` | Lending, borrowing, repayment classification, undo, splitting bills |
| `storage` | Backup round-trip, malformed and hostile imports, empty and duplicate data |
| `security` | Stored-XSS regressions on every field a backup file can set |
| `flows` | The paths a person walks daily: add, edit, delete, pay a bill, check cash, browse history |

## Two things that will bite you

**Money strings contain non-breaking spaces.** `Intl.NumberFormat` emits U+00A0
(and sometimes U+202F) inside formatted amounts. `MAD 1,000` typed on your
keyboard is *not* equal to `MAD 1,000` from the app. Every comparison in the
harness goes through `norm()` for exactly this reason — use `t.eq` / `t.has`
rather than raw `===`, or you will chase failures where both sides look
identical on screen.

**`document.body.textContent` includes the inline `<script>`.** The whole app
lives in one `<script>` inside `<body>`, so searching the body text for `NaN`
or a function name finds the *source code*. Read `#shell` (`app.shellText()`)
when asserting on what is rendered.

## Conventions

- `t.eq(label, got, want)` — normalised string/number equality
- `t.near(label, got, want, tol)` — money comparison, defaults to a cent
- `t.ok` / `t.no` — truthiness, with an optional detail shown on failure
- `t.has(label, haystack, needle)` — normalised substring
- `t.todo(label, why)` — a **known, unfixed** defect. Reported on every run,
  never fails the build. Use this instead of deleting a test for a bug that is
  real but not yet fixed, so open problems stay visible.

When you fix a bug, add the regression test in the suite that owns that area.
Never weaken an assertion to make a run pass — if behaviour legitimately
changed, change the expectation and say so in the commit.
