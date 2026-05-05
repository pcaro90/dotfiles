function b64 -d "Smart base64 decoding"
    if set -q argv[1]
        test -f $argv[1]; and base64 -d <$argv[1]; or printf '%s' $argv[1] | base64 -d
    else
        base64 -d
    end
end
