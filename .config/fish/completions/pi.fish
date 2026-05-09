# Completions for `pi --ssh <TAB>` — suggests SSH hosts
# Hosts come from `__fish_print_hostnames` (/usr/share/fish/functions/__fish_print_hostnames.fish)
complete -c pi \
    -n "test (commandline --current-process --tokens-expanded --cut-at-cursor)[-1] = '--ssh'" \
    -d "Remote host" \
    -xa "(__fish_print_hostnames)"
