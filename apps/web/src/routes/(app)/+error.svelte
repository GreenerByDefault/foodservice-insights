<script lang="ts">
import { page } from '$app/state';
import ErrorPage from '$lib/components/error-page.svelte';
</script>

<!-- Exists so a failure on a page you are already signed into keeps the header, rather than
     dropping you onto the bare page at the root boundary. -->
<ErrorPage status={page.status} />
