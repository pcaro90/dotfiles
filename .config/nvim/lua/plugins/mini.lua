return {
  {
    "nvim-mini/mini.nvim",
    lazy = false,
    config = function()
      -- Delete buffer without changing window layout
      require("mini.bufremove").setup()

      -- File explorer
      require("mini.files").setup({
        mappings = {
          go_in = "L",
          go_in_plus = "l",
        },
      })

      -- Indent scope visual line and text objects (ai, ii)
      require("mini.indentscope").setup({
        symbol = "│",
        draw = {
          delay = 0,
          animation = function()
            return 0
          end,
        },
      })

      -- Auto pairs
      require("mini.pairs").setup()

      -- Surround -
      require("mini.surround").setup({
        mappings = {
          add = "ys",
          delete = "ds",
          find = "",
          find_left = "",
          highlight = "",
          replace = "cs",
        },
        search_method = "cover_or_next",
      })
    end,
    keys = {
      {
        "<C-1>",
        function()
          if not MiniFiles.close() then
            MiniFiles.open(vim.api.nvim_buf_get_name(0), false)
            MiniFiles.reveal_cwd()
          end
        end,
        desc = "Explorer: Open file explorer",
      },
      {
        "<leader>bd",
        function()
          require("mini.bufremove").delete(0, false)
        end,
        desc = "Buffers: Delete current buffer",
      },
    },
  },
}
