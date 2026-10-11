name = "Fresh match-ups"
description = "Each round seats every pilot with the people they have flown against the least."
author = "WebFPV Club Timer"

function generate(round, pilots, channels, options)
    local max = options.max_pilots_per_race
    local race_count = math.ceil(#pilots / max)
    local heats = {}
    for i = 1, race_count do heats[i] = {} end

    -- Seat pilots one at a time in the heat where they have met the fewest
    -- pilots so far; ties go to the emptier heat so heats stay even.
    for _, pilot in ipairs(shuffle(pilots)) do
        local best, best_score = nil, nil
        for i, heat in ipairs(heats) do
            if #heat < max then
                local met = 0
                for _, other in ipairs(heat) do met = met + history(pilot.id, other) end
                local score = met * 100 + #heat
                if best == nil or score < best_score then best, best_score = i, score end
            end
        end
        table.insert(heats[best], pilot.id)
    end

    for i, heat in ipairs(heats) do heats[i] = minimise_channel_change(heat) end
    return heats
end
