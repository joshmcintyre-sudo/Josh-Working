import { chromium } from 'playwright'
const dir = '/tmp/claude-0/-home-user-Josh-Working/238f6b2f-5d33-5e23-87a3-e5477bddbd2c/scratchpad'
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' })
const p = await b.newPage({ viewport: { width: 1600, height: 950 } })
const errors = []
p.on('pageerror', (e) => errors.push(`PAGEERROR ${e.message}`))
p.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && errors.push(m.text()))

await p.goto('http://localhost:3000/', { waitUntil: 'networkidle' })
await p.evaluate(() => localStorage.clear())
await p.reload({ waitUntil: 'networkidle' })
await p.getByText('Service body accessory loom').click()
await p.waitForTimeout(1500)

// formboard with trunks
await p.getByRole('button', { name: 'Formboard' }).click()
await p.waitForTimeout(900)
await p.screenshot({ path: `${dir}/8-trunks.png` })

// click the roof trunk -> segment inspector
await p.getByText(/Roof trunk · 4w/).first().click({ force: true })
await p.waitForTimeout(500)
await p.screenshot({ path: `${dir}/9-segment.png` })

// right-click a node in the schematic for the quick menu
await p.getByRole('button', { name: 'Schematic' }).click()
await p.waitForTimeout(600)
await p.getByText('Central locking ac…').first().click({ button: 'right', force: true })
await p.waitForTimeout(400)
await p.screenshot({ path: `${dir}/10-menu.png` })
await p.keyboard.press('Escape')

// right-click a run and insert a splice
await p.getByText(/^C-204 ·/).first().click({ button: 'right', force: true })
await p.waitForTimeout(400)
await p.getByText('Insert splice…').click()
await p.waitForTimeout(400)
await p.screenshot({ path: `${dir}/11-splice-prompt.png` })
await p.getByRole('button', { name: 'Insert splice' }).click()
await p.waitForTimeout(700)
await p.screenshot({ path: `${dir}/12-spliced.png` })

// delete confirmation
await p.getByText('Reverse buzzer').first().click({ button: 'right', force: true })
await p.waitForTimeout(400)
await p.getByRole('button', { name: 'Delete', exact: true }).click()
await p.waitForTimeout(400)
await p.screenshot({ path: `${dir}/13-confirm.png` })

console.log('ERRORS:', errors.length ? errors.join('\n') : 'none')
await b.close()
