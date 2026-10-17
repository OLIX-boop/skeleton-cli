#!/usr/bin/env bash
# Generates a ~25-file TypeScript backend in the current directory (shared by the eval cases).
set -e
for area in billing:Invoice,InvoicePdf,Tax auth:Session,Password,OAuth catalog:Product,ProductSearch,Pricing \
            orders:Cart,Checkout,Shipping notify:Email,Sms db:Repo,Migrations http:Routes,Middleware util:Money,Dates; do
  dir="src/${area%%:*}"; mkdir -p "$dir"
  for name in $(echo "${area#*:}" | tr ',' ' '); do
    file="$dir/$(echo "$name" | sed 's/\([a-z]\)\([A-Z]\)/\1-\2/g' | tr 'A-Z' 'a-z').ts"
    {
      echo "/** $name module of the shop backend. */"
      echo "import { Repo } from '../db/repo';"
      echo
      echo "export interface ${name}Options {"; echo "  retries: number;"; echo "  timeoutMs: number;"; echo "}"
      echo
      echo "export class ${name}Service {"
      echo "  constructor(private readonly repo: Repo, private readonly options: ${name}Options) {}"
      for i in 0 1 2 3 4 5; do
        echo
        echo "  /** Handles ${name} operation $i. */"
        echo "  async op$i(id: string): Promise<number> {"
        for j in 0 1 2 3 4 5 6 7; do
          echo "    const step$j = await this.repo.query('${name}_${i}_${j}', { id, attempt: $j });"
          echo "    if (!step$j) throw new Error('${name} step $j failed for ' + id);"
        done
        echo "    return $i;"; echo "  }"
      done
      echo "}"
    } > "$file"
  done
done
cat > src/util/strings.ts <<'TS'
/** Small string helpers. */
export function greet(name: string): string {
  return `Hello, ${name}! Thanks for your order. We will recieve payment shortly.`;
}
TS
printf '{\n  "name": "shop-backend",\n  "version": "1.0.0",\n  "private": true\n}\n' > package.json
printf '# shop-backend\n\nAn e-commerce backend.\n' > README.md
