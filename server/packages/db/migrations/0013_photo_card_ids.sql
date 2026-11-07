-- 0013 - Photo ids on the profile card as text.
--
-- profile_card() wrote each photo's id as a JSON number. Ids are 63-bit
-- integers; a JSON number above 2^53 loses its low digits in JavaScript (and
-- in most JSON decoders), so the API would have signed links for photo ids
-- that do not exist. Every other id the database hands to the apps in JSON
-- is text (account_view()); the card now follows. Nothing else changes.

CREATE OR REPLACE FUNCTION profile_card(p_user bigint) RETURNS jsonb
  LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
           'v', p.version,
           'name', p.display_name,
           'age', CASE WHEN p.hide_age THEN NULL ELSE extract(year FROM age(current_date, u.birth_date))::integer END,
           'gender', u.gender,
           'verified', u.is_verified,
           'intention', p.intention,
           'job', CASE WHEN p.text_state = 2 THEN p.job_title END,
           'about', CASE WHEN p.text_state = 2 THEN p.about END,
           'city', CASE WHEN l.travel_until > now() THEN l.travel_city_id ELSE l.home_city_id END,
           'traveling', CASE WHEN l.travel_until > now() THEN true END,
           'hd', p.hide_distance,
           'so', p.show_online,
           'photos', coalesce((SELECT jsonb_agg(jsonb_build_object('id', ph.id::text, 'w', ph.width, 'h', ph.height,
                                                                   'bh', ph.blurhash, 'bv', ph.blob_ver)
                                                ORDER BY ph.position)
                                 FROM photos ph WHERE ph.user_id = u.id AND ph.status = 3), '[]'),
           'prompts', coalesce((SELECT jsonb_agg(jsonb_build_object('p', pp.prompt_id, 'a', pp.answer, 'ms', pp.audio_ms)
                                                 ORDER BY pp.position)
                                  FROM profile_prompts pp WHERE pp.user_id = u.id AND pp.status = 2), '[]'),
           'fields', coalesce((SELECT jsonb_agg(jsonb_build_object('f', v.field_id, 'o', v.opt, 'os', v.opts,
                                                                   'n', v.num, 't', v.txt)
                                                ORDER BY f.sort, f.id)
                                 FROM profile_field_values v JOIN profile_field_defs f ON f.id = v.field_id
                                WHERE v.user_id = u.id AND f.is_public AND f.is_active), '[]')))
    FROM users u
    JOIN profiles p ON p.user_id = u.id
    LEFT JOIN user_locations l ON l.user_id = u.id
   WHERE u.id = p_user
     AND u.status IN (3, 4)
$$;
