<script lang="ts">
import favicon from '$lib/assets/favicon.svg';
import './layout.css';

let { children } = $props();
</script>

<svelte:head><link rel="icon" href={favicon}></svelte:head>

<main class="mx-auto flex min-h-svh max-w-2xl flex-col items-start justify-center gap-4 p-8">
  {@render children()}
</main>
