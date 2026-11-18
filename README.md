# DDFE Lab Homepage

Data-Driven Fluid Engineering Lab (Inha University) 홈페이지입니다.
GitHub Pages 에서 Jekyll 로 자동 빌드됩니다. 별도 빌드 과정 없이 파일을 수정하고 push 하면 1–2분 후 반영됩니다.

## 1. GitHub Pages 배포 (최초 1회)

1. GitHub 에서 새 저장소를 만듭니다.
   - **`<아이디>.github.io`** 로 만들면 주소가 `https://<아이디>.github.io/` 가 됩니다. (권장)
   - 다른 이름(예: `ddfe`)으로 만들면 주소가 `https://<아이디>.github.io/ddfe/` 가 되며,
     이 경우 `_config.yml` 의 `baseurl` 을 `"/ddfe"` 로 바꿔야 합니다.
2. 이 폴더에서:
   ```bash
   git init
   git add .
   git commit -m "Initial site"
   git branch -M main
   git remote add origin https://github.com/<아이디>/<저장소이름>.git
   git push -u origin main
   ```
3. 저장소 **Settings → Pages** 에서 Source 를 **Deploy from a branch**, Branch 를 **main / (root)** 로 지정합니다.

## 2. 내용 수정 방법

대부분의 내용은 `_data/` 폴더의 YAML 파일만 고치면 됩니다.

| 수정할 내용 | 파일 |
|---|---|
| 뉴스 (홈의 Recent News 는 최신 5개 자동 표시) | `_data/news.yml` |
| 현재 멤버 / PI 약력 | `_data/members.yml` |
| 졸업생 | `_data/alumni.yml` |
| 연구과제 | `_data/projects.yml` |
| 유튜브 영상 | `_data/videos.yml` |
| 논문 목록 | `publications.md` |
| 상단 메뉴 | `_data/navigation.yml` |
| 이메일·주소 (footer) | `_config.yml` |
| 홈 소개 문구 | `index.html` |
| Research 페이지 | `_data/research.yml` |
| 디자인 (색상, 글꼴 등) | `assets/css/style.css` |

### 뉴스 추가 예시
`_data/news.yml` 맨 위에 추가합니다 (최신이 위로). 사진은 `assets/images/news/` 에 넣습니다.

```yaml
- date: 2026-Dec
  title: New Publication in Journal of Fluid Mechanics
  subtitle: 논문 제목 (선택)
  body: |
    본문은 **Markdown** 으로 작성합니다. 링크는 [link](https://...) 형식.

    빈 줄을 넣으면 문단이 나뉩니다.
  images:
    - /assets/images/news/2026-12-jfm.jpg
```

### 멤버 추가 예시
사진(세로 3:4 비율 권장)을 `assets/images/members/` 에 넣고 `_data/members.yml` 의 해당 그룹에 추가합니다.

```yaml
      - name: Gildong Hong
        name_ko: 홍길동
        photo: /assets/images/members/gildong-hong.jpg
        email: gildong@inha.edu
```

### 논문 추가
`publications.md` 의 목록 맨 위에 `1. ` 로 시작하는 줄을 추가합니다 (번호는 자동). 
연구실 멤버는 `**굵게**`, 교신저자 별표는 `\*` 로 씁니다.

### 유의사항
- YAML 은 **들여쓰기(스페이스)** 가 중요합니다. 탭 대신 스페이스를 쓰세요.
- 값에 `:` 가 들어가면 큰따옴표로 감싸세요. 예: `title: "PINNs: Application to ..."`
- 수정 후 GitHub 저장소의 **Actions** 탭에서 빌드 성공 여부(초록 체크)를 확인할 수 있습니다.

## 3. (선택) 로컬 미리보기

Ruby 가 설치되어 있다면:
```bash
bundle install
bundle exec jekyll serve
# http://localhost:4000 접속
```
