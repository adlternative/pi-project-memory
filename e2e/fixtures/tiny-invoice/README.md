# tiny-invoice

A dependency-free Node.js quote calculator.

- Entry point: `quote(items, { discountBps = 0 })` in `quote.js`.
- Each line has nonnegative safe-integer `unitCents` and positive safe-integer `quantity`.
- Returns `{ subtotalCents, discountCents, totalCents }`, always safe-integer cents.
- `discountBps` is an integer from 0 to 10000. The discount rounds down.
- Invalid input and unsafe totals are rejected.
- Run `node --test quote.test.js`; in the live E2E, use the provided `run_project_tests` tool.

This is a synthetic disposable project. Collaboration labels are not application data and must not be added to source, tests or this README.
