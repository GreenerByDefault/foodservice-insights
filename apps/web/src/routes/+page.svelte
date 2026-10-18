<script lang="ts">
import { APP_NAME } from '@gbd/core';
import PublicHeader from '#lib/components/public-header.svelte';
import { Button } from '#lib/components/ui/button/index.js';
import { pageTitle } from '#lib/page-title.js';

const steps = [
  {
    title: 'Upload your purchasing data',
    body: 'A CSV or Excel export of what you ordered: product name, date ordered, and weight.',
  },
  {
    title: 'We analyze it',
    body: 'Each product is categorized and matched to the climate impact of the food it contains.',
  },
  {
    title: 'Get your report',
    body: 'A PDF and an Excel workbook with charts and recommendations, emailed when it is ready.',
  },
] as const;
</script>

<svelte:head>
  <title>{pageTitle()}</title>
  <meta
    name="description"
    content="Upload your foodservice purchasing data and get back a report on its climate impact, with recommendations."
  >
</svelte:head>

<!-- The marketing page, and the only path `static/robots.txt` lets a crawler have. The copy is our
     draft; GBD comms will supply the real language and design (REQUIREMENTS.md § Landing page). -->
<div class="flex min-h-svh flex-col">
  <PublicHeader>
    {#snippet actions()}
      <Button href="/sign-in" variant="outline">Sign in</Button>
    {/snippet}
  </PublicHeader>

  <main class="flex flex-1 flex-col">
    <section class="page-width flex flex-col items-start gap-6 py-16 sm:py-24">
      <p class="text-sm font-medium text-primary">From Greener by Default</p>
      <h1 class="max-w-2xl text-4xl font-medium text-balance sm:text-5xl">
        See the climate impact of your food purchasing
      </h1>
      <p class="max-w-xl text-lg text-muted-foreground">
        Upload your procurement data and get back a report on the emissions behind what your
        kitchens buy, with recommendations for lowering them.
      </p>
      <Button href="/sign-in" size="lg" class="px-4">Get started</Button>
    </section>

    <section class="flex-1 bg-primary/5">
      <div class="page-width flex flex-col gap-8 py-16">
        <h2 class="text-2xl font-medium">How it works</h2>
        <ol class="grid gap-8 sm:grid-cols-3 sm:gap-6">
          {#each steps as step, index (step.title)}
            <li class="flex flex-col gap-2">
              <span
                class="flex size-8 items-center justify-center rounded-full bg-primary text-sm font-medium text-primary-foreground"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              <h3 class="font-medium">{step.title}</h3>
              <p class="text-sm text-muted-foreground">{step.body}</p>
            </li>
          {/each}
        </ol>
      </div>
    </section>
  </main>

  <footer class="border-t">
    <div class="page-width py-6">
      <p class="text-sm text-muted-foreground">
        {APP_NAME}
        is a tool from
        <a class="link whitespace-nowrap" href="https://www.greenerbydefault.com"
          >Greener by Default</a
        >.
      </p>
    </div>
  </footer>
</div>
