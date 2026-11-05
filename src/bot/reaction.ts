import type { ChannelPort } from '../channel/port';
import { log } from '../core/logger';

/**
 * Add a "Typing" reaction (敲键盘) to a message to give text-mode users an
 * instant "I got your message and I'm responding" cue while the agent is still
 * thinking. Matches the conventional Feishu UX for "the other side is
 * replying". Card mode doesn't need this — the streaming card already
 * shows a "正在思考…" footer the moment it's posted.
 *
 * Channel-neutral on purpose: the port's `addReaction`/`removeReaction` are
 * the "working indicator" primitive (WeChat will map them to `sendTyping`).
 * Channels without it throw {@link ChannelUnsupportedError}, which the
 * try/catch swallows — losing a decoration must never break the reply flow.
 *
 * Returns the reaction id on success, undefined on any failure.
 */
export async function addWorkingReaction(
  port: ChannelPort,
  messageId: string,
): Promise<string | undefined> {
  try {
    const id = await port.addReaction(messageId, 'Typing');
    if (id) log.info('reaction', 'added', { messageId, reactionId: id });
    return id;
  } catch (err) {
    log.warn('reaction', 'add-failed', {
      messageId,
      err: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }
}

/** Remove a previously-added reaction. Tolerates errors silently — best
 * effort cleanup; a leftover reaction is harmless. */
export async function removeReaction(
  port: ChannelPort,
  messageId: string,
  reactionId: string,
): Promise<void> {
  try {
    await port.removeReaction(messageId, reactionId);
    log.info('reaction', 'removed', { messageId, reactionId });
  } catch (err) {
    log.warn('reaction', 'remove-failed', {
      messageId,
      reactionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
