export function lexiIconResource(name: string, muted: boolean = false): Resource {
  switch (name) {
    case 'dock-home':
      return muted ? $r('app.media.ic_dock_home_muted') : $r('app.media.ic_dock_home');
    case 'dock-vault':
      return muted ? $r('app.media.ic_dock_vault_muted') : $r('app.media.ic_dock_vault');
    case 'dock-explore':
      return muted ? $r('app.media.ic_dock_explore_muted') : $r('app.media.ic_dock_explore');
    case 'dock-profile':
      return muted ? $r('app.media.ic_dock_profile_muted') : $r('app.media.ic_dock_profile');
    case 'home':
      return muted ? $r('app.media.ic_dock_home_muted') : $r('app.media.ic_dock_home');
    case 'vault':
      return muted ? $r('app.media.ic_dock_vault_muted') : $r('app.media.ic_dock_vault');
    case 'explore':
      return muted ? $r('app.media.ic_dock_explore_muted') : $r('app.media.ic_dock_explore');
    case 'profile':
      return muted ? $r('app.media.ic_dock_profile_muted') : $r('app.media.ic_dock_profile');
    case 'note':
      return muted ? $r('app.media.ic_note_muted') : $r('app.media.ic_note');
    case 'study':
      return muted ? $r('app.media.ic_study_muted') : $r('app.media.ic_study');
    case 'markdown':
      return muted ? $r('app.media.ic_markdown_muted') : $r('app.media.ic_markdown');
    case 'mindmap':
      return muted ? $r('app.media.ic_mindmap_muted') : $r('app.media.ic_mindmap');
    case 'canvas':
      return muted ? $r('app.media.ic_canvas_muted') : $r('app.media.ic_canvas');
    case 'graph':
      return muted ? $r('app.media.ic_graph_muted') : $r('app.media.ic_graph');
    case 'link':
      return muted ? $r('app.media.ic_link_muted') : $r('app.media.ic_link');
    case 'search':
      return muted ? $r('app.media.ic_search_muted') : $r('app.media.ic_search');
    case 'plus':
      return muted ? $r('app.media.ic_plus_muted') : $r('app.media.ic_plus');
    case 'folder':
      return muted ? $r('app.media.ic_folder_muted') : $r('app.media.ic_folder');
    case 'tag':
      return muted ? $r('app.media.ic_tag_muted') : $r('app.media.ic_tag');
    case 'star':
    case 'spark':
      return muted ? $r('app.media.ic_star_muted') : $r('app.media.ic_star');
    case 'pin':
      return muted ? $r('app.media.ic_pin_muted') : $r('app.media.ic_pin');
    case 'trash':
      return muted ? $r('app.media.ic_trash_muted') : $r('app.media.ic_trash');
    case 'back':
    case 'chevron_left':
      return muted ? $r('app.media.ic_back_muted') : $r('app.media.ic_back');
    case 'chevron':
    case 'chevron_right':
      return muted ? $r('app.media.ic_chevron_muted') : $r('app.media.ic_chevron');
    case 'sun':
      return muted ? $r('app.media.ic_sun_muted') : $r('app.media.ic_sun');
    case 'shield':
      return muted ? $r('app.media.ic_shield_muted') : $r('app.media.ic_shield');
    case 'info':
      return muted ? $r('app.media.ic_info_muted') : $r('app.media.ic_info');
    case 'export':
      return muted ? $r('app.media.ic_export_muted') : $r('app.media.ic_export');
    case 'undo':
      return muted ? $r('app.media.ic_undo_muted') : $r('app.media.ic_undo');
    case 'redo':
      return muted ? $r('app.media.ic_redo_muted') : $r('app.media.ic_redo');
    default:
      return muted ? $r('app.media.ic_note_muted') : $r('app.media.ic_note');
  }
}

@Component
export struct LexiIcon {
  @Prop name: string = 'note';
  @Prop iconSize: number = 22;
  @Prop muted: boolean = false;

  build() {
    Image(lexiIconResource(this.name, this.muted))
      .width(this.iconSize)
      .height(this.iconSize)
      .draggable(false)
      .accessibilityLevel('no')
  }
}
