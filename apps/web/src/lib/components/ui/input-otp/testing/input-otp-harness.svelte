<!-- The smallest mount of the three components together: `Slot` needs a `cell` from `Root`'s
     children snippet, so there is no way to render one from a test file alone. -->
<script lang="ts">
import * as InputOTP from '../index.js';

let { maxlength = 6 }: { maxlength?: number } = $props();
</script>

<InputOTP.Root inputId="harness-code" {maxlength} aria-label="Sign-in code">
  {#snippet children({ cells })}
    <InputOTP.Group>
      {#each cells as cell, index (index)}
        <InputOTP.Slot {cell} />
      {/each}
    </InputOTP.Group>
  {/snippet}
</InputOTP.Root>
