<script lang="ts">
import { page } from '$app/state';
import ErrorPage from '$lib/components/error-page.svelte';
</script>

<!-- This error route exists to keep the organization's nav in place when something below it fails. -->
<ErrorPage status={page.status} />
