function _parent_jump -d "Jumps to parent directory several times"
    set -l jumps (math (string length $argv) - 1)
    echo cd (string repeat -n $jumps '../')
end
