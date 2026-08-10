<script lang="ts">
import { page } from '$app/state';
import ErrorPage from '$lib/components/error-page.svelte';
</script>

<!-- Keeps the organization's nav in place when something below it fails, most often a report id
     that belongs to another organization and so reads as a 404. -->
<ErrorPage status={page.status} />
