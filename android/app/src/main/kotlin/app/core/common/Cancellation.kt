package app.core.common

import kotlin.coroutines.cancellation.CancellationException

/**
 * [runCatching], without the part that catches cancellation.
 *
 * `kotlin.runCatching` catches `Throwable`, and inside a coroutine that
 * includes the `CancellationException` the machinery throws to unwind a
 * cancelled job. So `runCatching` around a suspending call does not mean "if
 * this fails"; it means "if this fails, or if it was cancelled", and the two
 * want opposite handling. A failure is an outcome to show somebody; a
 * cancellation is this work going away, with nobody left to show anything to.
 *
 * Conflating them is not theoretical: a `LaunchedEffect` whose key changes
 * while a request is in flight cancels that request, and a `runCatching`
 * around it reports the cancellation as a failed call, so the screen that
 * replaced it latches on an error for work that was never meant to finish.
 *
 * Rethrowing lets cancellation do its job: the coroutine unwinds, and whoever
 * cancelled it gets the silence they asked for.
 */
inline fun <T> runCatchingUnlessCancelled(block: () -> T): Result<T> =
    try {
        Result.success(block())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Throwable) {
        Result.failure(error)
    }
