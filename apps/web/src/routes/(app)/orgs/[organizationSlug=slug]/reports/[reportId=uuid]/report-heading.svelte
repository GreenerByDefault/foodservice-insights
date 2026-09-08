<script lang="ts">
import PageHeading from '$lib/components/page-heading.svelte';
import { subheading, type Creator } from '$lib/reports/subheading';

interface Props {
  name: string;
  siteName: string | null;
  creator: Creator;
}

let { name, siteName, creator }: Props = $props();
</script>

<PageHeading>{name}</PageHeading>
<p class="text-sm text-muted-foreground">{subheading(siteName, creator)}</p>
