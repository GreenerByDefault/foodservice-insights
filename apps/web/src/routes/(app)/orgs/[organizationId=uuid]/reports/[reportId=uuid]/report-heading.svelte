<script lang="ts">
import { subheading, type Creator } from '$lib/reports/subheading';

interface Props {
  name: string;
  siteName: string | null;
  creator: Creator;
}

let { name, siteName, creator }: Props = $props();
</script>

<h1 class="text-2xl font-semibold tracking-tight">{name}</h1>
<p class="text-sm text-muted-foreground">{subheading(siteName, creator)}</p>
