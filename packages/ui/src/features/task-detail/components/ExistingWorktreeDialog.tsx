import { FolderOpen } from "@phosphor-icons/react";
import { AlertDialog, Button, Code, Flex } from "@radix-ui/themes";
import { useExistingWorktreeConfirmStore } from "../stores/existingWorktreeConfirmStore";

/**
 * Globally-mounted confirmation shown when a user starts a worktree task on a
 * branch that already has a worktree checked out. Confirming reuses that
 * worktree for the task instead of creating a new one.
 */
export function ExistingWorktreeDialog() {
  const isOpen = useExistingWorktreeConfirmStore((s) => s.isOpen);
  const branch = useExistingWorktreeConfirmStore((s) => s.branch);
  const worktreePath = useExistingWorktreeConfirmStore((s) => s.worktreePath);
  const accept = useExistingWorktreeConfirmStore((s) => s.accept);
  const cancel = useExistingWorktreeConfirmStore((s) => s.cancel);

  return (
    <AlertDialog.Root
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <AlertDialog.Content maxWidth="460px" size="2">
        <AlertDialog.Title className="text-base">
          <Flex align="center" gap="2">
            <FolderOpen size={18} weight="bold" color="var(--accent-9)" />
            Worktree already exists
          </Flex>
        </AlertDialog.Title>
        <AlertDialog.Description className="text-sm">
          A worktree is already checked out on{" "}
          {branch ? <Code>{branch}</Code> : "this branch"}
          {worktreePath ? (
            <>
              {" "}
              at <Code>{worktreePath}</Code>
            </>
          ) : null}
          . Continue and use that worktree for this task?
        </AlertDialog.Description>

        <Flex justify="end" gap="2" mt="4">
          <AlertDialog.Cancel>
            <Button variant="soft" color="gray" size="1" onClick={cancel}>
              Cancel
            </Button>
          </AlertDialog.Cancel>
          <AlertDialog.Action>
            <Button variant="solid" size="1" onClick={accept}>
              Use existing worktree
            </Button>
          </AlertDialog.Action>
        </Flex>
      </AlertDialog.Content>
    </AlertDialog.Root>
  );
}
