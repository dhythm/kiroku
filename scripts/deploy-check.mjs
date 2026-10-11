import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { parse } from 'jsonc-parser'
// No credentials are read or printed.
const errors = []
const config = parse(
  readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'),
  errors,
  { allowTrailingComma: true },
)
if (errors.length) throw new Error('Deploy blocked: wrangler.jsonc is invalid.')
if (config.vars?.FREE_PLAN_CONFIRMED !== 'true')
  throw new Error(
    'Deploy blocked: confirm the target account uses Workers Free, then set FREE_PLAN_CONFIRMED=true. Do not upgrade billing.',
  )
const database = config.d1_databases?.find(
  (binding) => binding.binding === 'DB',
)
if (
  !database ||
  !/^[0-9a-f-]{36}$/i.test(database.database_id) ||
  database.database_id === '00000000-0000-0000-0000-000000000000'
)
  throw new Error(
    'Deploy blocked: set the kiroku D1 database_id from your account first.',
  )
console.log(
  'Deployment configuration checked. AI remains governed by its explicit enablement and runtime safeguards.',
)
