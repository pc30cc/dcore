package app.core.feature.auth.welcome

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The welcome's bubbles as plain arrays, stepped once per frame.
 *
 * Positions and sizes are in pixels, time in seconds; tuning values are in dp
 * and multiplied by [density]. Nothing here allocates after [layout]: a frame
 * is arithmetic over the arrays, so the frame loop makes no garbage.
 *
 * Each bubble floats around a home of its own (a weak spring with damping,
 * a slow wander of the home itself, a sideways sway and a vertical bob),
 * bubbles push each other apart softly, and the text and the buttons are
 * kept clear. A bubble can be dragged and flung (the spring brings it back
 * into the cluster) or popped: it bursts into a ring of droplets and forms
 * again at the bottom of the field a few seconds later.
 *
 * With [layout]'s `intro`, every bubble starts held inside one large bubble
 * in the middle, which appears, swells and bursts at [BURST_AT], sending them
 * out to their homes. Without it they rest at their homes from the start.
 */
class BubbleField(private val density: Float, seed: Long = 0x5EED) {

    var count = 0
        private set

    /** Seconds since [layout]. */
    var time = 0f
        private set

    // Bubbles.
    val x = FloatArray(CAPACITY)
    val y = FloatArray(CAPACITY)
    val vx = FloatArray(CAPACITY)
    val vy = FloatArray(CAPACITY)

    /** The radius drawn now. */
    val r = FloatArray(CAPACITY)

    /** The radius at rest. */
    val baseR = FloatArray(CAPACITY)
    val homeX = FloatArray(CAPACITY)
    val homeY = FloatArray(CAPACITY)
    val phase = FloatArray(CAPACITY)
    val freq = FloatArray(CAPACITY)

    /** Squash and stretch after a knock, decaying to 0. */
    val wobble = FloatArray(CAPACITY)

    /** What a bubble carries: a face slot (0 and up), [EMPTY], or a label ([labelOf]). */
    val kind = IntArray(CAPACITY)
    val state = IntArray(CAPACITY)

    /** Back to front, smallest first: the order to draw in (and hit-test in reverse). */
    val order = IntArray(CAPACITY)

    private val ax = FloatArray(CAPACITY)
    private val ay = FloatArray(CAPACITY)
    private val heldX = FloatArray(CAPACITY)
    private val heldY = FloatArray(CAPACITY)
    private val timer = FloatArray(CAPACITY)

    // The opening bubble.
    var coreX = 0f
        private set
    var coreY = 0f
        private set

    /** Its radius now (0 once burst). */
    var coreR = 0f
        private set

    /** 0..1: how much of it is drawn (fades in, gone once burst). */
    var coreAlpha = 0f
        private set
    private var coreBase = 0f
    private var intro = false

    // Droplets of a pop.
    val particleX = FloatArray(PARTICLES)
    val particleY = FloatArray(PARTICLES)
    private val particleVx = FloatArray(PARTICLES)
    private val particleVy = FloatArray(PARTICLES)

    /** Seconds left; 0 or less is a free slot. */
    val particleLife = FloatArray(PARTICLES)
    val particleSize = FloatArray(PARTICLES)
    val particleTint = IntArray(PARTICLES)
    private var nextParticle = 0

    // The flash ring of a pop.
    val ringX = FloatArray(RINGS)
    val ringY = FloatArray(RINGS)
    val ringR = FloatArray(RINGS)

    /** Seconds since the pop; below 0 a free slot. */
    val ringAge = FloatArray(RINGS) { -1f }
    private var nextRing = 0

    // The field and what to keep clear.
    private var width = 0f
    private var height = 0f
    private var fieldTop = 0f
    private var fieldBottom = 0f
    private val keepOut = FloatArray(MAX_KEEP_OUT * 4)
    private var keepOutCount = 0

    // Dragging.
    private var dragged = -1
    private var dragTargetX = 0f
    private var dragTargetY = 0f
    private var grabDx = 0f
    private var grabDy = 0f

    private var rng = seed or 1L

    val laidOut: Boolean get() = count > 0

    /**
     * Places the bubbles for a [w] x [h] scene whose free band runs from
     * [top] to [bottom], keeping clear of [keepOutRects] (left, top, right,
     * bottom; several, flattened). The first call with [startIntro] begins
     * the opening burst; a later call (new size, larger text) only moves the
     * homes, and the bubbles float over to them.
     */
    fun layout(w: Float, h: Float, top: Float, bottom: Float, keepOutRects: FloatArray, startIntro: Boolean) {
        val first = count == 0
        width = w
        height = h
        fieldTop = top
        fieldBottom = max(bottom, top + 1f)
        keepOutCount = min(keepOutRects.size / 4, MAX_KEEP_OUT)
        keepOutRects.copyInto(keepOut, endIndex = keepOutCount * 4)

        val dp = density
        val area = w * (fieldBottom - fieldTop)
        val reference = REFERENCE_W * REFERENCE_H * dp * dp
        val share = area / reference
        val scale = sqrt(share).coerceIn(0.72f, 1.18f)
        val n = when {
            share >= 0.75f -> SPEC_R.size
            share >= 0.5f -> SPEC_R.size - 3
            else -> SPEC_R.size - 6
        }
        count = n
        for (i in 0 until n) {
            baseR[i] = SPEC_R[i] * dp * scale
            kind[i] = SPEC_KIND[i]
            if (first) {
                phase[i] = nextFloat() * TWO_PI
                freq[i] = 0.45f + nextFloat() * 0.5f
            }
        }
        placeHomes(n)
        sortOrder(n)
        dragged = -1

        when {
            first -> {
                time = 0f
                if (startIntro) startIntro(n, again = false) else rest(n)
            }
            // Still inside the opening bubble: the same opening, measured again.
            intro -> startIntro(n, again = true)
            else -> for (i in 0 until n) {
                if (state[i] == DRAGGED) state[i] = FREE
                // A bubble the larger band adds starts at its home.
                if (r[i] == 0f && state[i] != POPPED) rest(i, i + 1)
            }
        }
    }

    /** Every bubble at its home, still: the calm arrangement (reduced motion). */
    fun settle() {
        intro = false
        coreR = 0f
        coreAlpha = 0f
        rest(count)
        for (p in 0 until PARTICLES) particleLife[p] = 0f
        for (k in 0 until RINGS) ringAge[k] = -1f
    }

    private fun rest(n: Int) = rest(0, n)

    private fun rest(from: Int, to: Int) {
        for (i in from until to) {
            state[i] = FREE
            x[i] = homeX[i]
            y[i] = homeY[i]
            vx[i] = 0f
            vy[i] = 0f
            r[i] = baseR[i]
            wobble[i] = 0f
        }
    }

    private fun startIntro(n: Int, again: Boolean) {
        intro = true
        coreX = width / 2f
        coreY = (fieldTop + fieldBottom) / 2f
        coreBase = min(width * 0.43f, (fieldBottom - fieldTop) * 0.46f)
        if (!again) {
            coreR = coreBase * 0.6f
            coreAlpha = 0f
        }
        // Inside the opening bubble each one waits in a small copy of the layout: toward its home,
        // as far out as its home is (never over the word in the middle). The burst then sends every
        // bubble straight out to its place, and no two cross.
        val halfW = max(width / 2f, 1f)
        val halfH = max((fieldBottom - fieldTop) / 2f, 1f)
        for (i in 0 until n) {
            var ox = (homeX[i] - coreX) / halfW * 0.8f
            var oy = (homeY[i] - coreY) / halfH * 0.8f
            val length = sqrt(ox * ox + oy * oy)
            val reach = length.coerceIn(0.48f, 0.82f)
            if (length < 1e-3f) {
                ox = cos(phase[i])
                oy = sin(phase[i])
            } else {
                ox /= length
                oy /= length
            }
            heldX[i] = ox * reach
            heldY[i] = oy * reach
            state[i] = HELD
            vx[i] = 0f
            vy[i] = 0f
            wobble[i] = 0f
        }
        holdInsideCore(n)
    }

    // MARK: - Homes

    /**
     * Best-candidate sampling, largest first: each bubble takes, of a few
     * dozen random spots in the band, the one farthest from those already
     * placed. Even, never gridded, and the same for the same seed.
     */
    private fun placeHomes(n: Int) {
        val saved = rng
        rng = HOME_SEED
        val dp = density
        for (k in 0 until n) {
            val i = byRadiusDescending(k, n)
            val radius = baseR[i]
            // Words are never cut by the screen's edge; faces at most by a third.
            val inset = if (BubbleField.labelIn(kind[i]) >= 0) radius + 10f * dp else radius * 0.62f
            val minX = min(inset, width / 2f)
            val maxX = max(width - inset, minX)
            val minY = fieldTop + radius * 0.8f
            val maxY = max(minY, fieldBottom - radius)
            var bestX = width / 2f
            var bestY = (minY + maxY) / 2f
            var bestScore = -Float.MAX_VALUE
            repeat(CANDIDATES) {
                // Two draws averaged: more of the cluster in the middle, fewer at the sides.
                val cx = minX + (nextFloat() + nextFloat()) * 0.5f * (maxX - minX)
                val cy = minY + nextFloat() * (maxY - minY)
                var score = Float.MAX_VALUE
                for (m in 0 until k) {
                    val j = byRadiusDescending(m, n)
                    val dx = cx - homeX[j]
                    val dy = cy - homeY[j]
                    val gap = sqrt(dx * dx + dy * dy) - radius - baseR[j]
                    if (gap < score) score = gap
                }
                // Away from what is kept clear, too.
                for (q in 0 until keepOutCount) {
                    val gap = distanceToRect(cx, cy, q) - radius - 6f * dp
                    if (gap < score) score = gap
                }
                if (score > bestScore) {
                    bestScore = score
                    bestX = cx
                    bestY = cy
                }
            }
            homeX[i] = bestX
            homeY[i] = bestY
        }
        rng = saved
    }

    /**
     * The [k]-th bubble by size, largest first. The spec's tail is its
     * smallest bubbles, so the first [n] by size are always indices below [n].
     */
    @Suppress("UNUSED_PARAMETER")
    private fun byRadiusDescending(k: Int, n: Int): Int = SPEC_BY_SIZE[k]

    private fun sortOrder(n: Int) {
        for (k in 0 until n) order[n - 1 - k] = SPEC_BY_SIZE[k]
    }

    private fun distanceToRect(px: Float, py: Float, q: Int): Float {
        val l = keepOut[q * 4]
        val t = keepOut[q * 4 + 1]
        val rr = keepOut[q * 4 + 2]
        val b = keepOut[q * 4 + 3]
        val dx = max(max(l - px, 0f), px - rr)
        val dy = max(max(t - py, 0f), py - b)
        return sqrt(dx * dx + dy * dy)
    }

    // MARK: - Stepping

    /** Moves everything on by [seconds] (capped, so a late frame does not jump). */
    fun step(seconds: Float) {
        if (count == 0) return
        val dt = seconds.coerceIn(0f, MAX_STEP)
        val sub = if (dt > 1f / 50f) 2 else 1
        val h = dt / sub
        for (s in 0 until sub) stepOnce(h)
    }

    private fun stepOnce(h: Float) {
        time += h
        val n = count
        if (intro) stepCore(n)

        val dp = density
        val t = time
        for (i in 0 until n) {
            ax[i] = 0f
            ay[i] = 0f
            when (state[i]) {
                POPPED -> {
                    timer[i] -= h
                    if (timer[i] <= 0f) reform(i)
                }
                DRAGGED -> {
                    val follow = min(1f, h * DRAG_FOLLOW)
                    val nx = x[i] + (dragTargetX - x[i]) * follow
                    val ny = y[i] + (dragTargetY - y[i]) * follow
                    vx[i] = (nx - x[i]) / h
                    vy[i] = (ny - y[i]) / h
                    x[i] = nx
                    y[i] = ny
                }
                FREE -> {
                    // Extra damping for a moment after the burst, so the bubbles settle without overshooting.
                    val settle = if (t < BURST_AT + SETTLE) DAMPING + SETTLE_DAMPING * (1f - (t - BURST_AT) / SETTLE).coerceIn(0f, 1f) else DAMPING
                    val wander = WANDER * dp
                    val hx = homeX[i] + wander * sin(0.23f * t + phase[i])
                    val hy = homeY[i] + wander * 0.7f * cos(0.19f * t + phase[i] * 1.7f)
                    ax[i] = SPRING * (hx - x[i]) - settle * vx[i] + SWAY * dp * sin(freq[i] * t + phase[i])
                    // Buoyancy: a steady lift, a little more for the small ones, held by the home's spring.
                    val lift = BUOYANCY * dp * (1f + 12f * dp / baseR[i])
                    ay[i] = SPRING * (hy - y[i]) - settle * vy[i] + BOB * dp * cos(freq[i] * 0.8f * t + phase[i] * 1.3f) - lift
                }
            }
        }

        collide(n, dp)
        keepClear(n)
        sinceRebalance += h
        if (sinceRebalance >= REBALANCE_EVERY) {
            sinceRebalance = 0f
            rebalance(n)
        }

        val maxV = MAX_SPEED * dp
        for (i in 0 until n) {
            if (state[i] != FREE) continue
            vx[i] += ax[i] * h
            vy[i] += ay[i] * h
            val speed2 = vx[i] * vx[i] + vy[i] * vy[i]
            if (speed2 > maxV * maxV) {
                val k = maxV / sqrt(speed2)
                vx[i] *= k
                vy[i] *= k
            }
            x[i] += vx[i] * h
            y[i] += vy[i] * h
            // Bubbles that grow (after the burst, or forming again) ease to full size.
            r[i] += (baseR[i] - r[i]) * (1f - exp(-h * GROW))
        }
        for (i in 0 until n) wobble[i] = max(0f, wobble[i] - wobble[i] * h * WOBBLE_DECAY)

        stepParticles(h, dp)
    }

    private fun stepCore(n: Int) {
        val t = time
        if (t < BURST_AT) {
            val appear = (t / APPEAR).coerceIn(0f, 1f)
            coreAlpha = min(1f, t / 0.16f)
            var scale = 0.6f + 0.4f * easeOutBack(appear)
            if (t > APPEAR) scale += 0.022f * sin((t - APPEAR) * 9.5f)
            // A last swell before it goes.
            val swell = ((t - (BURST_AT - 0.14f)) / 0.14f).coerceIn(0f, 1f)
            scale += 0.07f * swell * swell
            coreR = coreBase * scale
            holdInsideCore(n)
        } else {
            burst(n)
        }
    }

    private fun holdInsideCore(n: Int) {
        val inner = coreR
        val t = time
        for (i in 0 until n) {
            if (state[i] != HELD) continue
            val jiggle = 0.02f * inner
            x[i] = coreX + heldX[i] * inner + jiggle * sin(t * 2.1f + phase[i])
            y[i] = coreY + heldY[i] * inner + jiggle * cos(t * 1.7f + phase[i])
            r[i] = baseR[i] * HELD_SCALE * (inner / coreBase)
        }
    }

    private fun burst(n: Int) {
        intro = false
        val dp = density
        ring(coreX, coreY, coreR)
        spray(coreX, coreY, coreR, 28)
        for (i in 0 until n) {
            if (state[i] != HELD) continue
            state[i] = FREE
            val ox = x[i] - coreX
            val oy = y[i] - coreY
            val d = sqrt(ox * ox + oy * oy).coerceAtLeast(1f)
            // Out from the middle, toward home, a little at random.
            vx[i] = (homeX[i] - x[i]) * LAUNCH + ox / d * 90f * dp + (nextFloat() - 0.5f) * 80f * dp
            vy[i] = (homeY[i] - y[i]) * LAUNCH + oy / d * 90f * dp + (nextFloat() - 0.5f) * 80f * dp
            wobble[i] = 0.08f
        }
        coreR = 0f
        coreAlpha = 0f
    }

    /** Pairs that overlap push apart (heavier bubbles less), with damping on approach. */
    private fun collide(n: Int, dp: Float) {
        val gap = GAP * dp
        for (i in 0 until n) {
            if (!moves(i)) continue
            for (j in i + 1 until n) {
                if (!moves(j)) continue
                val dx = x[j] - x[i]
                val dy = y[j] - y[i]
                val minD = r[i] + r[j] + gap
                val d2 = dx * dx + dy * dy
                if (d2 >= minD * minD || d2 < 1e-3f) continue
                val d = sqrt(d2)
                val nx = dx / d
                val ny = dy / d
                val overlap = minD - d
                val approach = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny
                var push = PUSH * overlap
                if (approach < 0f) push -= PUSH_DAMPING * approach
                val mi = r[i] * r[i]
                val mj = r[j] * r[j]
                val wi = if (state[i] == DRAGGED) 0f else if (state[j] == DRAGGED) 1f else mj / (mi + mj)
                val wj = if (state[j] == DRAGGED) 0f else if (state[i] == DRAGGED) 1f else mi / (mi + mj)
                ax[i] -= push * nx * wi * 2f
                ay[i] -= push * ny * wi * 2f
                ax[j] += push * nx * wj * 2f
                ay[j] += push * ny * wj * 2f
                // A deep overlap is also corrected in place, so nothing sits inside another.
                val fix = overlap * 0.25f
                if (state[i] == FREE) {
                    x[i] -= nx * fix * wi
                    y[i] -= ny * fix * wi
                }
                if (state[j] == FREE) {
                    x[j] += nx * fix * wj
                    y[j] += ny * fix * wj
                }
                val knock = min(0.07f, overlap / max(r[i], r[j]) * 0.4f)
                if (knock > wobble[i]) wobble[i] = knock
                if (knock > wobble[j]) wobble[j] = knock
            }
        }
    }

    /** The text, the buttons and the screen's sides push a free bubble back. */
    private fun keepClear(n: Int) {
        for (i in 0 until n) {
            if (state[i] != FREE) continue
            val radius = r[i]
            for (q in 0 until keepOutCount) {
                val l = keepOut[q * 4]
                val t = keepOut[q * 4 + 1]
                val rr = keepOut[q * 4 + 2]
                val b = keepOut[q * 4 + 3]
                val cx = x[i].coerceIn(l, rr)
                val cy = y[i].coerceIn(t, b)
                val dx = x[i] - cx
                val dy = y[i] - cy
                val d2 = dx * dx + dy * dy
                if (d2 >= radius * radius) continue
                if (d2 > 1e-3f) {
                    val d = sqrt(d2)
                    ax[i] += WALL * (radius - d) * dx / d
                    ay[i] += WALL * (radius - d) * dy / d
                } else {
                    // The centre is inside: out by the nearest side.
                    val toLeft = x[i] - l
                    val toRight = rr - x[i]
                    val toTop = y[i] - t
                    val toBottom = b - y[i]
                    val least = min(min(toLeft, toRight), min(toTop, toBottom))
                    when (least) {
                        toTop -> ay[i] -= WALL * (toTop + radius)
                        toBottom -> ay[i] += WALL * (toBottom + radius)
                        toLeft -> ax[i] -= WALL * (toLeft + radius)
                        else -> ax[i] += WALL * (toRight + radius)
                    }
                }
            }
            // Words stay whole on screen, faces at most half past a side; never far below or above it.
            val inside = if (labelIn(kind[i]) >= 0) radius else radius * 0.5f
            if (x[i] < inside) ax[i] += WALL * (inside - x[i])
            if (x[i] > width - inside) ax[i] -= WALL * (x[i] - (width - inside))
            if (y[i] < -radius) ay[i] += WALL * (-radius - y[i])
            if (y[i] > height + radius) ay[i] -= WALL * (y[i] - height - radius)
        }
    }

    private fun moves(i: Int): Boolean = state[i] == FREE || state[i] == DRAGGED

    private var sinceRebalance = 0f

    /**
     * Two bubbles of about the same kind and size that would each be nearer
     * the other's home trade homes. Bubbles cannot pass through each other,
     * so after a burst or a fling one can be held away from its home by the
     * ones in between; trading lets the cluster settle evenly instead.
     */
    private fun rebalance(n: Int) {
        for (i in 0 until n) {
            if (state[i] != FREE) continue
            for (j in i + 1 until n) {
                if (state[j] != FREE) continue
                if ((labelIn(kind[i]) >= 0) != (labelIn(kind[j]) >= 0)) continue
                val ratio = baseR[i] / baseR[j]
                if (ratio > 1.4f || ratio < 1f / 1.4f) continue
                val now = distance(i, homeX[i], homeY[i]) + distance(j, homeX[j], homeY[j])
                val traded = distance(i, homeX[j], homeY[j]) + distance(j, homeX[i], homeY[i])
                if (traded < now * 0.8f) {
                    val hx = homeX[i]
                    val hy = homeY[i]
                    homeX[i] = homeX[j]
                    homeY[i] = homeY[j]
                    homeX[j] = hx
                    homeY[j] = hy
                }
            }
        }
    }

    private fun distance(i: Int, px: Float, py: Float): Float {
        val dx = x[i] - px
        val dy = y[i] - py
        return sqrt(dx * dx + dy * dy)
    }

    // MARK: - Touch

    /** The front-most bubble under ([px], [py]), or -1. Small bubbles are given a finger-sized target. */
    fun hit(px: Float, py: Float): Int {
        val minTouch = TOUCH_RADIUS * density
        for (k in count - 1 downTo 0) {
            val i = order[k]
            if (!moves(i)) continue
            val reach = max(r[i], minTouch)
            val dx = px - x[i]
            val dy = py - y[i]
            if (dx * dx + dy * dy <= reach * reach) return i
        }
        return -1
    }

    fun grab(i: Int, px: Float, py: Float) {
        if (i !in 0 until count || !moves(i)) return
        if (dragged >= 0 && dragged != i) state[dragged] = FREE
        dragged = i
        state[i] = DRAGGED
        grabDx = x[i] - px
        grabDy = y[i] - py
        dragTargetX = x[i]
        dragTargetY = y[i]
        wobble[i] = max(wobble[i], 0.05f)
    }

    fun dragTo(px: Float, py: Float) {
        if (dragged < 0) return
        dragTargetX = px + grabDx
        dragTargetY = py + grabDy
    }

    /** Lets go with the finger's velocity (pixels per second). */
    fun release(velocityX: Float, velocityY: Float) {
        val i = dragged
        if (i < 0) return
        dragged = -1
        if (state[i] != DRAGGED) return
        state[i] = FREE
        val maxFling = MAX_FLING * density
        val speed = sqrt(velocityX * velocityX + velocityY * velocityY)
        val k = if (speed > maxFling) maxFling / speed else 1f
        vx[i] = velocityX * k
        vy[i] = velocityY * k
    }

    /** Pops bubble [i]: droplets, a flash, and it forms again at the bottom a few seconds later. */
    fun pop(i: Int): Boolean {
        if (i !in 0 until count || !moves(i)) return false
        if (dragged == i) dragged = -1
        state[i] = POPPED
        timer[i] = REFORM_MIN + nextFloat() * REFORM_SPREAD
        ring(x[i], y[i], r[i])
        spray(x[i], y[i], r[i], 14)
        return true
    }

    private fun reform(i: Int) {
        val dp = density
        state[i] = FREE
        x[i] = (homeX[i] + (nextFloat() - 0.5f) * 60f * dp).coerceIn(baseR[i], width - baseR[i])
        y[i] = fieldBottom - baseR[i] * 0.4f
        vx[i] = 0f
        vy[i] = -(70f + nextFloat() * 70f) * dp
        r[i] = baseR[i] * 0.12f
        wobble[i] = 0.06f
    }

    // MARK: - Droplets

    private fun ring(cx: Float, cy: Float, radius: Float) {
        val k = nextRing
        nextRing = (nextRing + 1) % RINGS
        ringX[k] = cx
        ringY[k] = cy
        ringR[k] = radius
        ringAge[k] = 0f
    }

    private fun spray(cx: Float, cy: Float, radius: Float, drops: Int) {
        val dp = density
        for (d in 0 until drops) {
            val p = nextParticle
            nextParticle = (nextParticle + 1) % PARTICLES
            val angle = d * TWO_PI / drops + (nextFloat() - 0.5f) * 0.4f
            val c = cos(angle)
            val s = sin(angle)
            particleX[p] = cx + c * radius * 0.92f
            particleY[p] = cy + s * radius * 0.92f
            val speed = radius * (1.6f + nextFloat() * 1.4f) + 50f * dp
            particleVx[p] = c * speed
            particleVy[p] = s * speed
            particleLife[p] = PARTICLE_LIFE * (0.7f + nextFloat() * 0.5f)
            particleSize[p] = (1.4f + nextFloat() * 1.8f) * dp * (if (radius > 60f * dp) 1.4f else 1f)
            particleTint[p] = d % TINTS
        }
    }

    private fun stepParticles(h: Float, dp: Float) {
        val drag = 1f - min(1f, h * 3f)
        for (p in 0 until PARTICLES) {
            if (particleLife[p] <= 0f) continue
            particleLife[p] -= h
            particleVx[p] *= drag
            particleVy[p] = particleVy[p] * drag + 40f * dp * h
            particleX[p] += particleVx[p] * h
            particleY[p] += particleVy[p] * h
        }
        for (k in 0 until RINGS) {
            if (ringAge[k] < 0f) continue
            ringAge[k] += h
            if (ringAge[k] > RING_LIFE) ringAge[k] = -1f
        }
    }

    // MARK: - Small things

    /** xorshift64*: deterministic for a seed, and no allocation. */
    private fun nextFloat(): Float {
        var v = rng
        v = v xor (v shl 13)
        v = v xor (v ushr 7)
        v = v xor (v shl 17)
        rng = v
        return ((v ushr 40).toInt() and 0xFFFFFF) / 16_777_216f
    }

    private fun easeOutBack(t: Float): Float {
        val c1 = 1.70158f
        val c3 = c1 + 1f
        val u = t - 1f
        return 1f + c3 * u * u * u + c1 * u * u
    }

    companion object {
        const val CAPACITY = 28
        const val PARTICLES = 96
        const val RINGS = 8
        const val MAX_KEEP_OUT = 4

        const val HELD = 0
        const val FREE = 1
        const val DRAGGED = 2
        const val POPPED = 3

        /** A glass bubble with nothing inside. */
        const val EMPTY = -1

        /** The [kind] of a bubble that carries the [label]-th action word. */
        fun labelOf(label: Int): Int = -2 - label

        /** The label a [kind] carries, or -1. */
        fun labelIn(kind: Int): Int = if (kind <= -2) -2 - kind else -1

        /** The opening: it appears by [APPEAR], swells, and bursts at [BURST_AT]; all settled by [INTRO_END]. */
        const val APPEAR = 0.35f
        const val BURST_AT = 1.05f
        const val INTRO_END = 2.8f

        /** Tints the droplets cycle through (the rim's colours). */
        const val TINTS = 6
        const val RING_LIFE = 0.32f
        const val PARTICLE_LIFE = 0.55f

        private const val TWO_PI = (2 * PI).toFloat()
        private const val HOME_SEED = 0x2F6E2B1L
        private const val CANDIDATES = 40
        private const val MAX_STEP = 1f / 20f

        // The band the sizes below were chosen for (dp).
        private const val REFERENCE_W = 411f
        private const val REFERENCE_H = 500f

        // Motion, per second (dp where it is a distance).
        private const val SPRING = 1.8f
        private const val DAMPING = 1.9f
        private const val SETTLE = 1.8f
        private const val SETTLE_DAMPING = 0.8f
        private const val SWAY = 15f
        private const val BOB = 10f
        private const val BUOYANCY = 5f
        private const val WANDER = 10f
        private const val PUSH = 70f
        private const val PUSH_DAMPING = 6f
        private const val GAP = 3f
        private const val WALL = 46f
        private const val GROW = 6f
        private const val WOBBLE_DECAY = 4.5f
        private const val DRAG_FOLLOW = 28f
        private const val LAUNCH = 2.4f
        private const val MAX_SPEED = 2600f
        private const val MAX_FLING = 2200f
        private const val TOUCH_RADIUS = 22f
        private const val HELD_SCALE = 0.42f
        private const val REFORM_MIN = 2.4f
        private const val REFORM_SPREAD = 2.4f
        private const val REBALANCE_EVERY = 0.5f

        /**
         * The bubbles (dp radius) and what each carries: faces in most, the
         * three action words in three, and a few empty glass ones.
         */
        private val SPEC_R = floatArrayOf(
            58f, 50f, 43f, 39f, 37f, 35f, 33f, 31f,
            34f, 32f, 30f,
            27f, 25f, 24f, 23f, 22f, 21f, 20f, 19f, 18f,
            14f, 12f, 10f, 9f, 8f, 7f,
        )
        private val SPEC_KIND = intArrayOf(
            0, 1, 2, 3, 4, 5, 6, EMPTY,
            -2, -3, -4,
            7, 8, 9, 10, 11, 12, 13, 14, 15,
            EMPTY, 16, EMPTY, EMPTY, EMPTY, EMPTY,
        )

        /** Indices of [SPEC_R], largest first (ties keep spec order). */
        private val SPEC_BY_SIZE: IntArray = SPEC_R.indices.sortedByDescending { SPEC_R[it] }.toIntArray()
    }
}
