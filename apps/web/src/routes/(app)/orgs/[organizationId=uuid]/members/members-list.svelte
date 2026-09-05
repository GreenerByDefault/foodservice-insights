<script lang="ts">
import type { MemberRow } from './+page.server.ts';

interface Props {
  members: readonly MemberRow[];
}

let { members }: Props = $props();

const ROLE_LABEL = { admin: 'Admin', member: 'Member' } as const;
</script>

<ul class="w-full divide-y border-y">
  {#each members as member (member.email)}
    <li class="flex w-full items-center justify-between gap-4 px-2 py-3">
      <span class="flex min-w-0 flex-col">
        <span class="min-w-0 truncate font-medium">
          {member.displayName ?? member.email}
          {#if member.isYou}
            <span class="text-muted-foreground">(You)</span>
          {/if}
        </span>
        {#if member.displayName}
          <span class="truncate text-sm text-muted-foreground">{member.email}</span>
        {/if}
      </span>
      <span class="shrink-0 text-sm text-muted-foreground">{ROLE_LABEL[member.role]}</span>
    </li>
  {/each}
</ul>
