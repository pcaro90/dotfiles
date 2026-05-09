# Completions for `pi --ssh` — suggests SSH hosts
# Hosts come from `__fish_print_hostnames` (/usr/share/fish/functions/__fish_print_hostnames.fish)
complete -c pi \
    -n "__fish_seen_argument -l ssh" \
    -d "Remote host" \
    -xa "(__fish_print_hostnames)"
