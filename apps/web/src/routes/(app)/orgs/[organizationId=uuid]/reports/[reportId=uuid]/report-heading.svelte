<script lang="ts">
interface Props {
  name: string;
  siteName: string | null;
  /** Null when the creating user's account was deleted. */
  creator: { displayName: string | null; email: string } | null;
}

let { name, siteName, creator }: Props = $props();

// Lowercase, so it reads naturally after "Created by".
function creatorName(creator: Props['creator']): string {
  if (creator === null) return 'a deleted user';
  return creator.displayName ?? creator.email;
}

function subheading(siteName: string | null, creator: Props['creator']): string {
  const parts = [...(siteName ? [siteName] : []), `Created by ${creatorName(creator)}`];
  return parts.join(' · ');
}
</script>

<h1 class="text-2xl font-semibold tracking-tight">{name}</h1>
<p class="text-sm text-muted-foreground">{subheading(siteName, creator)}</p>
