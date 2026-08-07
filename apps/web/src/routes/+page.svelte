<script lang="ts">
import AppTitle from '$lib/components/app-title.svelte';
import { Button } from '$lib/components/ui/button/index.js';
</script>

<AppTitle />

<p class="text-muted-foreground">Boilerplate only. Real features arrive in later phases.</p>

<div class="flex gap-2">
  <Button href="/reports/new">Upload a report</Button>
  <Button href="/health" variant="outline">Check health</Button>
</div>
