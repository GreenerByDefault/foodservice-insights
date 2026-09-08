<script lang="ts">
import ReportView from './report-view.svelte';
import type { PageProps } from './$types';

let { data }: PageProps = $props();
</script>

<ReportView {data} />
