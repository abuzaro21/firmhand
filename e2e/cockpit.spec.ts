import { expect, test, type Page } from '@playwright/test';

// The full operator journey in a real browser: the week runs on its own, stops for each human decision, the
// decisions are made in the inbox, the books reconcile, and replay proves it changed nothing.

async function noHorizontalScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, 'page must not scroll sideways').toBeLessThanOrEqual(1);
}

async function runUntilStop(page: Page) {
  const run = page.getByTestId('run-week');
  await expect(run).toBeEnabled();
  await run.click();
  // The run stops on its own when a decision is pending or the week is complete.
  await expect(page.getByTestId('approval').first().or(page.getByText('Week complete', { exact: false }).first())).toBeVisible({ timeout: 60_000 });
  await expect(run).not.toHaveText(/Pause/, { timeout: 10_000 });
}

test('operator runs the week, answers the inbox, and the record verifies', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Your inbox/ })).toBeVisible();
  await page.getByRole('button', { name: 'Fast' }).click();
  await noHorizontalScroll(page);

  // Day 2: a customer asks for 18% off. Sales may grant 10% alone, so the run stops for the operator.
  await runUntilStop(page);
  const first = page.getByTestId('approval').first();
  await expect(first).toContainText('discount');
  await expect(first).toContainText(/hash [0-9a-f]{12}/);
  await first.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByTestId('approval')).toHaveCount(0);

  // Day 5: Operations crashes. Finance notices from lack of progress, compensates, and asks the operator to restart it.
  await runUntilStop(page);
  const second = page.getByTestId('approval').first();
  await expect(second).toContainText(/restart|recover/i);
  await second.getByRole('button', { name: 'Approve' }).click();

  for (let i = 0; i < 8 && !(await page.getByTestId('run-week').isDisabled()); i++) {
    if (await page.getByTestId('approval').count()) await page.getByTestId('approval').first().getByRole('button', { name: 'Approve' }).click();
    else await runUntilStop(page);
  }
  await expect(page.getByTestId('run-week'), 'the week must have run to the end').toBeDisabled({ timeout: 30_000 });
  await expect(page.getByText(/Day 7/).first()).toBeVisible();
  await expect(page.getByText('9/9 pass')).toBeVisible();

  // KPI drill-down shows the records behind the number.
  await page.getByRole('button', { name: /Recognised revenue/ }).first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer).toContainText('Recognised revenue');
  await expect(drawer.locator('table, li').first()).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();

  // Proof: rebuild from the event log and compare with live tables.
  await page.getByRole('button', { name: 'Proof' }).click();
  await page.getByTestId('verify').click();
  await expect(page.getByTestId('verify-result')).toContainText('Match');

  // Replay a closed day: no side effects, and it lands on the same checksum as the close snapshot.
  await page.getByRole('button', { name: 'Replay' }).click();
  await expect(page.getByText('side effects: none')).toBeVisible();
  await expect(page.getByText(/= close snapshot/)).toBeVisible();
  await noHorizontalScroll(page);
});

test('watch mode narrates from the event log', async ({ page }) => {
  await page.goto('/#watch');
  await page.getByRole('button', { name: /Watch a Company Day/ }).click();
  await expect(page.getByText('A company opens')).toBeVisible();
  await page.getByTestId('run-day').click();
  await expect(page.getByText(/Day 1 closed/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Snapshot checksum [0-9a-f]{8}/).first()).toBeVisible();
  await noHorizontalScroll(page);
});

test('a forged approval hash is refused by the server even if the browser is tampered with', async ({ page, request }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Fast' }).click();
  await runUntilStop(page);
  const id = (await page.getByTestId('approval').first().locator('header b').textContent())!.trim();
  const res = await page.evaluate(async (apId) => {
    const r = await fetch(`/api/approvals/${apId}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: true, hash: '0'.repeat(64) }) });
    return { status: r.status, body: await r.json() };
  }, id);
  expect(res.status).toBe(400);
  await page.reload();
  await expect(page.getByTestId('approval')).toHaveCount(1);
  // A different visitor (no cookie) cannot see or touch this company.
  const anon = await request.get('/api/state', { headers: { cookie: '' } });
  expect(anon.status()).toBe(401);
});
