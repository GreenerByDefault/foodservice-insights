<script lang="ts">
import ReportView from './polling/view.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<ReportView {data} />
