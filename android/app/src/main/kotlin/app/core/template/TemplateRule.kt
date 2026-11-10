package app.core.template

import app.core.model.UiConfig
import app.core.ui.theme.Templates

/**
 * Which template is drawn, from the person's stored choice and the admin's
 * `config.ui`:
 * 1. the choice, when it is a template this build ships and `ui` offers it;
 * 2. otherwise `ui`'s default, when this build ships it;
 * 3. otherwise `neon`.
 *
 * A choice stays stored when it stops being offered (rule 1 skips it until
 * it is offered again), and a person on [DEFAULT] follows every later
 * change of the default without an update. Without a `ui` (nothing received
 * yet, or a server older than templates) the server's own default applies
 * ([UiConfig.Default]).
 */
object TemplateRule {
    /** The stored choice that means "the admin's default". */
    const val DEFAULT: String = "default"

    /** What [effective] falls back to when nothing else applies. */
    const val FALLBACK: String = Templates.NEON

    /** A template id as the server sends it (ids this build does not ship included). */
    private val ID = Regex("^[a-z][a-z0-9_]{0,31}$")

    fun effective(choice: String, ui: UiConfig?, shipped: List<String> = Templates.ids): String {
        val config = ui ?: UiConfig.Default
        if (choice != DEFAULT && choice in shipped && choice in config.templates) return choice
        if (config.defaultTemplate in shipped) return config.defaultTemplate
        return FALLBACK
    }

    /** Whether [choice] may be picked on this phone and sent: [DEFAULT] or a template this build ships. */
    fun isChoice(choice: String, shipped: List<String> = Templates.ids): Boolean = choice == DEFAULT || choice in shipped

    /** Whether [choice] is a well-formed stored choice: [DEFAULT] or any template id (one a newer build ships included). */
    fun isWireChoice(choice: String): Boolean = choice == DEFAULT || ID.matches(choice)
}
