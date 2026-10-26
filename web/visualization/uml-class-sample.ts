/** Local editable example; never a model request or an assertion about repository classes. */
export const classSample=`classDiagram
class Project["프로젝트"] {
  +id: String
  +name: String
  +save(): bool
}
class Task["작업"] {
  +title: String
  +run(): Result
}
class Agent["코딩 에이전트"] {
  +model: String
  +execute(task: Task): Result
}
class BaseAgent {
  <<abstract>>
  +execute(task: Task): Result
}
class Repository["저장소 계약"] {
  <<interface>>
  +load(id: String): Project
}
class LocalRepository["로컬 저장소"] {
  +load(id: String): Project
}
Project "1" *-- "0..999" Task : 작업 보존
Task "0..999" --> "1" Agent : 실행 담당
Agent --|> BaseAgent : 상속
LocalRepository ..|> Repository : 구현
Agent ..> Repository : 조회
Project o-- Repository : 저장소 사용
Project -- LocalRepository : 로컬 연결
BaseAgent .. Repository : 계약 참조`;
