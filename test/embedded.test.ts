import { describe, expect, it } from 'vitest';
import { transformFile } from '../src/engine/transform.js';
import { scriptRegions } from '../src/languages/index.js';

const P = '{ /* ... */ }';

describe('embedded formats', () => {
  it('skeletonizes Vue script blocks and keeps the template', async () => {
    const src = `<template>
  <button @click="inc">{{ count }}</button>
</template>

<script setup lang="ts">
import { ref } from 'vue';
const props = defineProps<{ start: number }>();
const count = ref(props.start);
function inc(): void {
  count.value++;
}
</script>

<style scoped>
button { color: red; }
</style>
`;
    const out = await transformFile('Counter.vue', src, { mode: 'skeleton' });
    expect(out.strategy).toBe('skeleton');
    expect(out.language).toEqual({ id: 'vue', fence: 'vue' });
    expect(out.strippedBodies).toBe(1);
    expect(out.content).toBe(src.replace('function inc(): void {\n  count.value++;\n}', `function inc(): void ${P}`));
  });

  it('handles Svelte with plain JS and a module script', async () => {
    const src = `<script context="module">
  export function preload() { return fetch('/x'); }
</script>
<script>
  let n = 0;
  const inc = () => { n += 1; };
</script>
<button on:click={inc}>{n}</button>
`;
    const out = await transformFile('App.svelte', src, { mode: 'skeleton' });
    expect(out.content).toContain(`export function preload() ${P}`);
    expect(out.content).toContain(`const inc = () => ${P};`);
    expect(out.content).toContain('<button on:click={inc}>{n}</button>');
  });

  it('handles Astro frontmatter as TypeScript', async () => {
    const src = `---
import Layout from '../layouts/Layout.astro';
interface Props { title: string }
const { title } = Astro.props;
function slug(s: string): string {
  return s.toLowerCase();
}
---
<Layout title={title}><h1>{slug(title)}</h1></Layout>
<script>
  document.querySelector('h1')?.addEventListener('click', () => {
    alert('hi');
  });
</script>
`;
    const out = await transformFile('index.astro', src, { mode: 'skeleton' });
    expect(out.content).toContain(`function slug(s: string): string ${P}`);
    expect(out.content).toContain('interface Props { title: string }');
    expect(out.content).toContain(`addEventListener('click', () => ${P});`);
    expect(out.strippedBodies).toBe(2);
  });

  it('keeps embedded files verbatim in full mode', async () => {
    const src = '<script>function f() { return 1; }</script>';
    const out = await transformFile('A.vue', src, { mode: 'full' });
    expect(out).toMatchObject({ content: src, strategy: 'full' });
  });

  it('skips JSON and template script types and unknown langs', () => {
    const src = '<script type="application/ld+json">{"a":1}</script><script lang="coffee">x = 1</script><script lang="tsx">let a</script>';
    expect(scriptRegions(src).map((r) => r.language)).toEqual(['tsx']);
  });
});
